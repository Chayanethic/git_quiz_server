const { initializeApp } = require('firebase/app');
const { getFirestore, initializeFirestore, CACHE_SIZE_UNLIMITED, enableIndexedDbPersistence } = require('firebase/firestore');
require('dotenv').config();

// Validate required environment variables
const requiredEnvVars = [
    'FIREBASE_API_KEY',
    'FIREBASE_AUTH_DOMAIN',
    'FIREBASE_PROJECT_ID',
    'FIREBASE_STORAGE_BUCKET',
    'FIREBASE_MESSAGING_SENDER_ID',
    'FIREBASE_APP_ID'
];

for (const envVar of requiredEnvVars) {
    if (!process.env[envVar]) {
        throw new Error(`Missing required environment variable: ${envVar}`);
    }
}

const firebaseConfig = {
    apiKey: process.env.FIREBASE_API_KEY,
    authDomain: process.env.FIREBASE_AUTH_DOMAIN,
    projectId: process.env.FIREBASE_PROJECT_ID,
    storageBucket: process.env.FIREBASE_STORAGE_BUCKET,
    messagingSenderId: process.env.FIREBASE_MESSAGING_SENDER_ID,
    appId: process.env.FIREBASE_APP_ID,
    measurementId: process.env.FIREBASE_MEASUREMENT_ID
};

// console.log('Initializing Firebase with config:', {
//     ...firebaseConfig,
//     apiKey: '***' // Hide API key in logs
// });

try {
    const app = initializeApp(firebaseConfig);
    
    // Initialize Firestore with settings
    const db = initializeFirestore(app, {
        cacheSizeBytes: CACHE_SIZE_UNLIMITED,
        experimentalForceLongPolling: true, // Add this for better compatibility
    });

    // Enable offline persistence
    enableIndexedDbPersistence(db).catch((err) => {
        console.warn('Failed to enable offline persistence:', err);
    });

    console.log('Firebase initialized successfully');
    module.exports = { db };
} catch (error) {
    console.error('Error initializing Firebase:', error);
    throw error;
} 