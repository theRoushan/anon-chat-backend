const admin = require('firebase-admin')

class FirebaseService {
  constructor() {
    this.isInitialized = false;
    this.db = null;
    
    // Initialize Firebase Admin SDK
    try {
      if (!admin.apps.length) {
        // Check if required environment variables are present
        if (!process.env.FIREBASE_PROJECT_ID || !process.env.FIREBASE_CLIENT_EMAIL || !process.env.FIREBASE_PRIVATE_KEY) {
          console.warn('Firebase environment variables not found. Firebase features will be disabled.');
          console.warn('To enable Firebase, set FIREBASE_PROJECT_ID, FIREBASE_CLIENT_EMAIL, and FIREBASE_PRIVATE_KEY in your .env file');
          return;
        }
        
        admin.initializeApp({
          credential: admin.credential.cert({
            projectId: process.env.FIREBASE_PROJECT_ID,
            clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
            privateKey: process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n')
          })
        })
      }
      
      this.db = admin.firestore()
      this.isInitialized = true;
      console.log('Firebase initialized successfully');
    } catch (error) {
      console.error('Failed to initialize Firebase:', error.message);
      console.warn('Firebase features will be disabled. Server will continue without Firebase integration.');
    }
  }

  // Save user data (write-only)
  async saveUser(userId, userData) {
    if (!this.isInitialized) {
      console.log(`Firebase not initialized - skipping user save for ${userId}`)
      return { success: true, userId, skipped: true }
    }
    
    try {
      const userDoc = {
        userId,
        gender: userData.gender,
        interests: userData.interests || [],
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
        totalChats: 0,
        totalMessages: 0,
        deviceInfo: {
          userAgent: userData.userAgent || 'unknown',
          language: userData.language || 'en',
          timezone: userData.timezone || 'UTC'
        }
      }

      await this.db.collection('users').doc(userId).set(userDoc)
      console.log(`User ${userId} saved to Firebase`)
      return { success: true, userId }
    } catch (error) {
      console.error('Failed to save user:', error)
      return { success: false, error: error.message }
    }
  }

  // Save room data (write-only)
  async saveRoom(roomId, roomData) {
    if (!this.isInitialized) {
      console.log(`Firebase not initialized - skipping room save for ${roomId}`)
      return { success: true, roomId, skipped: true }
    }
    
    try {
      const roomDoc = {
        roomId,
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
        endedAt: null,
        duration: 0,
        participants: {
          user1: {
            userId: roomData.user1.userId,
            gender: roomData.user1.gender,
            interests: roomData.user1.interests || [],
            joinedAt: admin.firestore.FieldValue.serverTimestamp(),
            leftAt: null
          },
          user2: {
            userId: roomData.user2.userId,
            gender: roomData.user2.gender,
            interests: roomData.user2.interests || [],
            joinedAt: admin.firestore.FieldValue.serverTimestamp(),
            leftAt: null
          }
        },
        messageCount: 0,
        status: 'active', // 'active', 'completed', 'abandoned'
        matchingCriteria: {
          genderPreference: roomData.genderPreference || 'any',
          interestMatch: roomData.interestMatch || false
        }
      }

      await this.db.collection('rooms').doc(roomId).set(roomDoc)
      console.log(`Room ${roomId} saved to Firebase`)
      return { success: true, roomId }
    } catch (error) {
      console.error('Failed to save room:', error)
      return { success: false, error: error.message }
    }
  }

  // Save message (write-only)
  async saveMessage(roomId, messageData) {
    if (!this.isInitialized) {
      console.log(`Firebase not initialized - skipping message save for room ${roomId}`)
      return { success: true, skipped: true }
    }
    
    try {
      const messageDoc = {
        senderId: messageData.senderId,
        content: messageData.content,
        type: messageData.type || 'text', // 'text', 'system', 'error'
        timestamp: admin.firestore.FieldValue.serverTimestamp(),
        isRead: false,
        metadata: {
          messageLength: messageData.content?.length || 0,
          containsEmoji: this.containsEmoji(messageData.content || ''),
          language: messageData.language || 'en'
        }
      }

      await this.db.collection('rooms').doc(roomId)
        .collection('messages').add(messageDoc)
      
      // Update room message count
      await this.db.collection('rooms').doc(roomId).update({
        messageCount: admin.firestore.FieldValue.increment(1)
      })

      return { success: true }
    } catch (error) {
      console.error('Failed to save message:', error)
      return { success: false, error: error.message }
    }
  }



  // End room (write-only)
  async endRoom(roomId, endReason = 'completed') {
    if (!this.isInitialized) {
      console.log(`Firebase not initialized - skipping end room for ${roomId}`)
      return { success: true, skipped: true }
    }
    
    try {
      const roomRef = this.db.collection('rooms').doc(roomId)
      const roomDoc = await roomRef.get()
      
      if (roomDoc.exists) {
        const roomData = roomDoc.data()
        const createdAt = roomData.createdAt
        const endedAt = admin.firestore.FieldValue.serverTimestamp()
        
        await roomRef.update({
          endedAt,
          duration: admin.firestore.FieldValue.increment(0), // Will be calculated
          status: endReason,
          'participants.user1.leftAt': endedAt,
          'participants.user2.leftAt': endedAt
        })


        console.log(`Room ${roomId} ended with reason: ${endReason}`)
        return { success: true }
      }
      
      return { success: false, error: 'Room not found' }
    } catch (error) {
      console.error('Failed to end room:', error)
      return { success: false, error: error.message }
    }
  }


  // Helper function to check if message contains emoji
  containsEmoji(text) {
    const emojiRegex = /[\u{1F600}-\u{1F64F}]|[\u{1F300}-\u{1F5FF}]|[\u{1F680}-\u{1F6FF}]|[\u{1F1E0}-\u{1F1FF}]|[\u{2600}-\u{26FF}]|[\u{2700}-\u{27BF}]/u
    return emojiRegex.test(text)
  }

}

module.exports = new FirebaseService()
