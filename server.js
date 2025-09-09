// Load environment variables first
require('dotenv').config();

const WebSocket = require('ws');
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const { v4: uuidv4 } = require('uuid');
const FirebaseService = require('./firebase');

const app = express();
const PORT = process.env.PORT || 3001;

// Middleware
app.use(helmet());
app.use(express.json()); // Parse JSON bodies
app.use(cors({
  origin: process.env.FRONTEND_URL || 'http://localhost:5173',
  credentials: true
}));

// Rate limiting
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100, // limit each IP to 100 requests per windowMs
  message: 'Too many requests from this IP, please try again later.'
});
app.use(limiter);

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({ status: 'OK', timestamp: new Date().toISOString() });
});

// Get online users count endpoint
app.get('/api/users/online', (req, res) => {
  const onlineCount = userConnections.size;
  res.json({ 
    count: onlineCount,
    timestamp: new Date().toISOString()
  });
});


// Save user data endpoint (write-only)
app.post('/api/users/save', async (req, res) => {
  try {
    const { userId, gender, interests, userAgent, language, timezone } = req.body;
    
    if (!userId || !gender) {
      return res.status(400).json({ 
        success: false, 
        error: 'userId and gender are required' 
      });
    }

    const result = await FirebaseService.saveUser(userId, {
      gender,
      interests: interests || [],
      userAgent,
      language,
      timezone
    });

    if (result.success) {
      res.json({ success: true, message: 'User data saved successfully' });
    } else {
      res.status(500).json({ success: false, error: result.error });
    }
  } catch (error) {
    console.error('Error saving user data:', error);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});


// Create HTTP server
const server = require('http').createServer(app);

// Create WebSocket server
const wss = new WebSocket.Server({ 
  server,
  path: '/ws',
  pingInterval: 30000, // Send ping every 30 seconds
  pingTimeout: 60000   // Wait 60 seconds for pong response
});

// In-memory storage for rooms and waiting queue
const rooms = new Map(); // roomId -> { users: Set, createdAt: Date }
const waitingQueue = new Set(); // Set of WebSocket connections waiting for pairing
const userConnections = new Map(); // userId -> { ws, roomId, lastActivity }

// Function to broadcast online user count to all connected users
function broadcastOnlineCount() {
  const onlineCount = userConnections.size;
  const message = JSON.stringify({
    type: 'online_count_update',
    count: onlineCount
  });
  
  console.log(`📊 [ONLINE] Broadcasting online count: ${onlineCount} to ${userConnections.size} connections`);
  
  let sentCount = 0;
  userConnections.forEach((conn, userId) => {
    if (conn.ws.readyState === WebSocket.OPEN) {
      conn.ws.send(message);
      sentCount++;
    }
  });
  
  console.log(`📊 [ONLINE] Sent online count to ${sentCount}/${userConnections.size} users`);
}


// Message sanitization
function sanitizeMessage(message) {
  if (typeof message !== 'string') return '';
  
  // Remove potentially dangerous content
  return message
    .trim()
    .slice(0, 1000) // Limit message length
    .replace(/[<>]/g, '') // Remove potential HTML tags
    .replace(/javascript:/gi, '') // Remove javascript: protocol
    .replace(/on\w+=/gi, ''); // Remove event handlers
}

// Rate limiting for messages
const messageRateLimit = new Map(); // userId -> { count, resetTime }

function checkMessageRateLimit(userId) {
  const now = Date.now();
  const userLimit = messageRateLimit.get(userId);
  
  if (!userLimit || now > userLimit.resetTime) {
    messageRateLimit.set(userId, { count: 1, resetTime: now + 60000 }); // 1 minute window
    return true;
  }
  
  if (userLimit.count >= 30) { // 30 messages per minute
    return false;
  }
  
  userLimit.count++;
  return true;
}

// Generate unique room ID
function generateRoomId() {
  return uuidv4();
}

// Create a new room with two users
function createRoom(user1, user2) {
  const roomId = generateRoomId();
  const room = {
    users: new Set([user1, user2]),
    createdAt: new Date()
  };
  
  rooms.set(roomId, room);
  
  // Update user connections
  userConnections.get(user1).roomId = roomId;
  userConnections.get(user2).roomId = roomId;
  
  // Save room to Firebase (write-only)
  const user1Data = userConnections.get(user1);
  const user2Data = userConnections.get(user2);
  
  FirebaseService.saveRoom(roomId, {
    user1: {
      id: user1,
      userId: user1,
      gender: user1Data.gender,
      interests: user1Data.interests || []
    },
    user2: {
      id: user2,
      userId: user2,
      gender: user2Data.gender,
      interests: user2Data.interests || []
    }
  });
  
  console.log(`Room ${roomId} created with users ${user1} and ${user2}`);
  return roomId;
}

// Remove user from room and handle cleanup
function removeUserFromRoom(userId) {
  const userConn = userConnections.get(userId);
  if (!userConn || !userConn.roomId) return;
  
  const room = rooms.get(userConn.roomId);
  if (!room) return;
  
  room.users.delete(userId);
  
  // Notify partner about disconnection and close their connection
  room.users.forEach(partnerId => {
    const partnerConn = userConnections.get(partnerId);
    if (partnerConn && partnerConn.ws.readyState === WebSocket.OPEN) {
      // Send notification first
      partnerConn.ws.send(JSON.stringify({
        type: 'partner_disconnected',
        message: 'Your chat partner has disconnected',
        onlineCount: userConnections.size
      }));
      
      // Close the partner's connection immediately
      setTimeout(() => {
        if (partnerConn.ws.readyState === WebSocket.OPEN) {
          partnerConn.ws.close(1000, 'Partner disconnected');
        }
      }, 100); // Small delay to ensure message is sent
    }
  });
  
  // Clean up room if empty
  if (room.users.size === 0) {
    rooms.delete(userConn.roomId);
    console.log(`Room ${userConn.roomId} deleted (empty)`);
  }
  
  // Clear user's room reference
  userConn.roomId = null;
}

// Add user to waiting queue
function addToWaitingQueue(userId) {
  waitingQueue.add(userId);
  console.log(`⏳ [QUEUE] User ${userId} added to waiting queue. Queue size: ${waitingQueue.size}`);
  console.log(`⏳ [QUEUE] Current queue:`, Array.from(waitingQueue));
}

// Remove user from waiting queue
function removeFromWaitingQueue(userId) {
  waitingQueue.delete(userId);
  console.log(`⏳ [QUEUE] User ${userId} removed from waiting queue. Queue size: ${waitingQueue.size}`);
  console.log(`⏳ [QUEUE] Current queue:`, Array.from(waitingQueue));
}

// Try to pair users from waiting queue
function tryPairUsers() {
  console.log(`🤝 [MATCHMAKING] Attempting to pair users. Queue size: ${waitingQueue.size}`);
  
  if (waitingQueue.size >= 2) {
    const users = Array.from(waitingQueue);
    const user1 = users[0];
    const user2 = users[1];
    
    console.log(`🤝 [MATCHMAKING] Found pair: ${user1} and ${user2}`);
    
    // Remove from waiting queue
    removeFromWaitingQueue(user1);
    removeFromWaitingQueue(user2);
    
    // Create room
    console.log(`🏠 [ROOM] Creating room for users ${user1} and ${user2}`);
    const roomId = createRoom(user1, user2);
    
    // Notify both users
    const user1Conn = userConnections.get(user1);
    const user2Conn = userConnections.get(user2);
    
    console.log(`🤝 [MATCHMAKING] User1 connection exists:`, !!user1Conn);
    console.log(`🤝 [MATCHMAKING] User2 connection exists:`, !!user2Conn);
    
    if (user1Conn && user1Conn.ws.readyState === WebSocket.OPEN) {
      const pairMessage = {
        type: 'paired',
        message: 'You have been paired with a stranger!',
        onlineCount: userConnections.size
      };
      console.log(`🤝 [MATCHMAKING] Sending pair message to user1:`, pairMessage);
      user1Conn.ws.send(JSON.stringify(pairMessage));
    }
    
    if (user2Conn && user2Conn.ws.readyState === WebSocket.OPEN) {
      const pairMessage = {
        type: 'paired',
        message: 'You have been paired with a stranger!',
        onlineCount: userConnections.size
      };
      console.log(`🤝 [MATCHMAKING] Sending pair message to user2:`, pairMessage);
      user2Conn.ws.send(JSON.stringify(pairMessage));
    }
    
    console.log(`🤝 [MATCHMAKING] Users ${user1} and ${user2} paired in room ${roomId}`);
    
    // Broadcast updated online count after pairing
    broadcastOnlineCount();
    
  } else {
    console.log(`🤝 [MATCHMAKING] Not enough users to pair. Queue size: ${waitingQueue.size}`);
  }
}

// Clean up inactive connections
function cleanupInactiveConnections() {
  const now = Date.now();
  const inactiveThreshold = 30 * 60 * 1000; // 30 minutes
  
  for (const [userId, conn] of userConnections.entries()) {
    if (now - conn.lastActivity > inactiveThreshold) {
      console.log(`Cleaning up inactive connection: ${userId}`);
      
      // Remove from room if in one
      if (conn.roomId) {
        removeUserFromRoom(userId);
      }
      
      // Remove from waiting queue if waiting
      removeFromWaitingQueue(userId);
      
      // Close connection
      if (conn.ws.readyState === WebSocket.OPEN) {
        conn.ws.close();
      }
      
      userConnections.delete(userId);
    }
  }
  
  // Broadcast updated online count after cleanup
  if (userConnections.size > 0) {
    broadcastOnlineCount();
  }
}

// WebSocket connection handling
wss.on('connection', (ws, req) => {
  const clientIP = req.socket.remoteAddress;
  const userAgent = req.headers['user-agent'] || 'unknown';
  
  console.log(`🔌 [WS] New WebSocket connection from ${clientIP}`);
  console.log(`🔌 [WS] User-Agent: ${userAgent}`);
  console.log(`🔌 [WS] Current userConnections size: ${userConnections.size}`);
  
  // Send welcome message - user should provide their data immediately
  const welcomeMessage = {
    type: 'connected',
    message: 'Connected to anonymous chat. Please provide your user data.',
    onlineCount: userConnections.size
  };
  
  console.log(`🔌 [WS] Sending welcome message:`, welcomeMessage);
  ws.send(JSON.stringify(welcomeMessage));
  
  // Handle incoming messages
  ws.on('message', (data) => {
    try {
      console.log(`📨 [WS] Received message from ${clientIP}:`, data.toString());
      const message = JSON.parse(data.toString());
      console.log(`📨 [WS] Parsed message:`, message);
      
      // Handle different message types
      if (message.type === 'user_data') {
        console.log(`👤 [USER_DATA] Processing user data from ${clientIP}`);
        const frontendUserId = message.userId;
        
        console.log(`👤 [USER_DATA] Frontend userId: ${frontendUserId}`);
        console.log(`👤 [USER_DATA] Gender: ${message.gender}`);
        console.log(`👤 [USER_DATA] Interests:`, message.interests);
        
        if (!frontendUserId) {
          console.error(`❌ [USER_DATA] No userId provided in user_data message`);
          ws.send(JSON.stringify({
            type: 'error',
            message: 'No userId provided in user_data message'
          }));
          return;
        }
        
        // Store user connection with frontend userId
        const userConnection = {
          ws,
          userId: frontendUserId,
          roomId: null,
          lastActivity: Date.now(),
          userAgent,
          gender: message.gender,
          interests: message.interests || []
        };
        
        console.log(`👤 [USER_DATA] Storing user connection:`, userConnection);
        userConnections.set(frontendUserId, userConnection);
        console.log(`👤 [USER_DATA] UserConnections size after adding: ${userConnections.size}`);
        
        // Save user data to Firebase (write-only)
        console.log(`🔥 [FIREBASE] Saving user to Firebase:`, {
          userId: frontendUserId,
          gender: message.gender,
          interests: message.interests || [],
          userAgent,
          language: message.language || 'en',
          timezone: message.timezone || 'UTC'
        });
        
        FirebaseService.saveUser(frontendUserId, {
          gender: message.gender,
          interests: message.interests || [],
          userAgent,
          language: message.language || 'en',
          timezone: message.timezone || 'UTC'
        });
        
        const response = {
          type: 'user_data_saved',
          message: 'User data saved successfully',
          userId: frontendUserId
        };
        
        console.log(`👤 [USER_DATA] Sending response:`, response);
        ws.send(JSON.stringify(response));
        
        // Add user to waiting queue
        console.log(`⏳ [QUEUE] Adding user ${frontendUserId} to waiting queue`);
        addToWaitingQueue(frontendUserId);
        console.log(`⏳ [QUEUE] Waiting queue size: ${waitingQueue.size}`);
        
        // Try to pair users after adding to queue
        console.log(`🤝 [MATCHMAKING] Attempting to pair users`);
        tryPairUsers();
        
        // Broadcast updated online count
        broadcastOnlineCount();
        
        return;
      }
      
      if (message.type === 'chat_message') {
        console.log(`💬 [CHAT] Processing chat message from ${clientIP}`);
        
        // Find the user connection by WebSocket
        let currentUserId = null;
        let userConn = null;
        
        console.log(`💬 [CHAT] Searching for user connection in ${userConnections.size} connections`);
        for (const [userId, conn] of userConnections.entries()) {
          if (conn.ws === ws) {
            currentUserId = userId;
            userConn = conn;
            console.log(`💬 [CHAT] Found user connection: ${userId}`);
            break;
          }
        }
        
        if (!currentUserId || !userConn) {
          console.error(`❌ [CHAT] User not found for WebSocket connection from ${clientIP}`);
          console.error(`❌ [CHAT] Available connections:`, Array.from(userConnections.keys()));
          ws.send(JSON.stringify({
            type: 'error',
            message: 'User not found. Please reconnect.'
          }));
          return;
        }
        
        // Update last activity
        userConn.lastActivity = Date.now();
        
        // Check rate limit
        if (!checkMessageRateLimit(currentUserId)) {
          ws.send(JSON.stringify({
            type: 'error',
            message: 'Message rate limit exceeded. Please slow down.'
          }));
          return;
        }
        
        // Sanitize message
        const sanitizedMessage = sanitizeMessage(message.content);
        if (!sanitizedMessage) {
          ws.send(JSON.stringify({
            type: 'error',
            message: 'Message cannot be empty'
          }));
          return;
        }
        
        // Check if user is in a room
        if (!userConn.roomId) {
          ws.send(JSON.stringify({
            type: 'error',
            message: 'You are not in a chat room'
          }));
          return;
        }
        
        const room = rooms.get(userConn.roomId);
        if (!room) {
          ws.send(JSON.stringify({
            type: 'error',
            message: 'Room not found'
          }));
          return;
        }
        
        // Broadcast message to room partners
        const messageToSend = {
          type: 'chat_message',
          content: sanitizedMessage,
          timestamp: new Date().toISOString(),
          from: 'you'
        };
        
        room.users.forEach(partnerId => {
          if (partnerId !== currentUserId) {
            const partnerConn = userConnections.get(partnerId);
            if (partnerConn && partnerConn.ws.readyState === WebSocket.OPEN) {
              partnerConn.ws.send(JSON.stringify({
                ...messageToSend,
                from: 'stranger'
              }));
            }
          }
        });
        
        // Send confirmation to sender
        ws.send(JSON.stringify(messageToSend));
        
        // Save message to Firebase (write-only)
        FirebaseService.saveMessage(userConn.roomId, {
          senderId: currentUserId,
          content: sanitizedMessage,
          type: 'text'
        });
        
        console.log(`Message from ${currentUserId} in room ${userConn.roomId}: ${sanitizedMessage}`);
      }
      
    } catch (error) {
      console.error('Error processing message:', error);
      ws.send(JSON.stringify({
        type: 'error',
        message: 'Invalid message format'
      }));
    }
  });
  
  // Handle pong responses to update lastActivity
  ws.on('pong', () => {
    // Find the user connection and update lastActivity
    for (const [userId, conn] of userConnections.entries()) {
      if (conn.ws === ws) {
        conn.lastActivity = Date.now();
        console.log(`💓 [HEARTBEAT] Updated activity for user ${userId}`);
        break;
      }
    }
  });
  
  // Handle disconnection
  ws.on('close', () => {
    console.log(`🔌 [WS] Connection closed from ${clientIP}`);
    
    // Find the user connection by WebSocket
    let currentUserId = null;
    console.log(`🔌 [WS] Searching for user connection in ${userConnections.size} connections`);
    
    for (const [userId, conn] of userConnections.entries()) {
      if (conn.ws === ws) {
        currentUserId = userId;
        console.log(`🔌 [WS] Found user connection: ${userId}`);
        break;
      }
    }
    
    if (currentUserId) {
      console.log(`🔌 [WS] Connection closed for user ${currentUserId}`);
      
      
      // Remove from waiting queue
      removeFromWaitingQueue(currentUserId);
      
      // Remove from room
      removeUserFromRoom(currentUserId);
      
      // Clean up user connection
      userConnections.delete(currentUserId);
      console.log(`🔌 [WS] UserConnections size after cleanup: ${userConnections.size}`);
      
      // Broadcast updated online count
      broadcastOnlineCount();
      
    } else {
      console.log(`❌ [WS] Connection closed for unknown user from ${clientIP}`);
      console.log(`❌ [WS] Available connections:`, Array.from(userConnections.keys()));
    }
  });
  
  // Handle errors
  ws.on('error', (error) => {
    // Find the user connection by WebSocket
    let currentUserId = null;
    for (const [userId, conn] of userConnections.entries()) {
      if (conn.ws === ws) {
        currentUserId = userId;
        break;
      }
    }
    
    if (currentUserId) {
      console.error(`WebSocket error for user ${currentUserId}:`, error);
      
      // Clean up on error
      removeFromWaitingQueue(currentUserId);
      removeUserFromRoom(currentUserId);
      userConnections.delete(currentUserId);
      
    } else {
      console.error('WebSocket error for unknown user:', error);
    }
  });
});

// Periodic cleanup of inactive connections
setInterval(cleanupInactiveConnections, 60000); // Every minute

// Periodic broadcast of online count to keep it accurate
setInterval(() => {
  if (userConnections.size > 0) {
    broadcastOnlineCount();
  }
}, 30000); // Every 30 seconds


// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('SIGTERM received, shutting down gracefully');
  wss.close(() => {
    server.close(() => {
      process.exit(0);
    });
  });
});

process.on('SIGINT', () => {
  console.log('SIGINT received, shutting down gracefully');
  wss.close(() => {
    server.close(() => {
      process.exit(0);
    });
  });
});

// Start server
server.listen(PORT, () => {
  console.log(`Anonymous Chat Server running on port ${PORT}`);
  console.log(`WebSocket endpoint: ws://localhost:${PORT}/ws`);
  console.log(`Health check: http://localhost:${PORT}/health`);
});

module.exports = { server, wss };
