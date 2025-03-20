require('dotenv').config();
const express = require('express');
const { db } = require('./firebase');
const { collection, doc, addDoc, getDoc, getDocs, query, where, orderBy, limit, Timestamp, updateDoc, setDoc } = require('firebase/firestore');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const multer = require('multer');
const pdfParse = require('pdf-parse');

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// CORS for frontend
app.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Methods', 'GET, POST');
    res.header('Access-Control-Allow-Headers', 'Content-Type');
    next();
});

const genAI = new GoogleGenerativeAI(process.env.GOOGLE_API_KEY);
const model = genAI.getGenerativeModel({ model: 'gemini-1.5-flash' });

const generateQuizId = () => Math.random().toString(36).substr(2, 6);

const generateContent = async (text, qType, numOptions, numQuestions, includeFlashcards) => {
    try {
        const prompt = `
Generate exactly ${numQuestions} quiz questions and ${includeFlashcards ? 'flashcards ' : ''}based on this text: "${text}". 
Quiz type: "${qType}" (true_false, multiple_choice, or mix). 
For multiple_choice, provide ${numOptions} options, one correct. 
Return in JSON format, no extra text or markdown:
{
    "questions": [
        {"question": "Text", "type": "true_false or multiple_choice", "options": ["opt1", ...] (for multiple_choice), "answer": "correct"}
    ],
    "flashcards": [
        {"term": "Term", "definition": "Definition"}
    ]
}
`;
        const result = await model.generateContent(prompt);
        const responseText = result.response.text().replace(/```json/g, '').replace(/```/g, '').trim();
        const content = JSON.parse(responseText);
        return {
            questions: content.questions || [],
            flashcards: includeFlashcards ? (content.flashcards || []) : []
        };
    } catch (error) {
        console.error('Error generating content:', error);
        return {
            questions: [{ question: 'Error occurred. Is this a test?', type: 'true_false', answer: 'True' }],
            flashcards: includeFlashcards ? [{ term: 'Error', definition: 'Try again later' }] : []
        };
    }
};

// Configure multer for file uploads
const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 5 * 1024 * 1024 } // Limit file size to 5MB
});

// Check if user has remaining free generations or active subscription
const checkUserUsage = async (userId) => {
    try {
        // Check user subscription status
        const userRef = doc(db, 'users', userId);
        const userSnap = await getDoc(userRef);
        
        if (!userSnap.exists()) {
            // New user - create profile with initial free generations
            await setDoc(userRef, {
                user_id: userId,
                free_generations_remaining: 10,
                subscription_status: 'free',
                subscription_expiry: null,
                created_at: Timestamp.now()
            });
            return { 
                canGenerate: true, 
                remainingFree: 10, 
                subscriptionStatus: 'free' 
            };
        }
        
        const userData = userSnap.data();
        
        // If user has active subscription, allow generation
        if (userData.subscription_status !== 'free') {
            // Check if subscription is still valid
            if (userData.subscription_expiry && userData.subscription_expiry.toDate() > new Date()) {
                return { 
                    canGenerate: true, 
                    remainingFree: 0, 
                    subscriptionStatus: userData.subscription_status 
                };
            } else {
                // Subscription expired, revert to free
                await updateDoc(userRef, {
                    subscription_status: 'free',
                    subscription_expiry: null
                });
                userData.subscription_status = 'free';
            }
        }
        
        // For free users, check remaining generations
        if (userData.free_generations_remaining > 0) {
            return { 
                canGenerate: true, 
                remainingFree: userData.free_generations_remaining, 
                subscriptionStatus: 'free' 
            };
        } else {
            return { 
                canGenerate: false, 
                remainingFree: 0, 
                subscriptionStatus: 'free' 
            };
        }
    } catch (error) {
        console.error('Error checking user usage:', error);
        throw error;
    }
};

// Decrease free generation count after successful generation
const decrementFreeUsage = async (userId) => {
    try {
        const userRef = doc(db, 'users', userId);
        const userSnap = await getDoc(userRef);
        
        if (userSnap.exists()) {
            const userData = userSnap.data();
            if (userData.subscription_status === 'free' && userData.free_generations_remaining > 0) {
                await updateDoc(userRef, {
                    free_generations_remaining: userData.free_generations_remaining - 1
                });
                return userData.free_generations_remaining - 1;
            }
        }
        return 0;
    } catch (error) {
        console.error('Error decrementing free usage:', error);
        return 0;
    }
};

// Get user subscription info
app.get('/api/user/subscription/:userId', async (req, res) => {
    const { userId } = req.params;
    try {
        const userRef = doc(db, 'users', userId);
        const userSnap = await getDoc(userRef);
        
        if (!userSnap.exists()) {
            // New user - create profile with initial free generations
            await setDoc(userRef, {
                user_id: userId,
                free_generations_remaining: 10,
                subscription_status: 'free',
                subscription_expiry: null,
                created_at: Timestamp.now()
            });
            
            return res.status(200).json({
                user_id: userId,
                free_generations_remaining: 10,
                subscription_status: 'free',
                subscription_expiry: null
            });
        }
        
        const userData = userSnap.data();
        
        // Check if subscription is still valid
        if (userData.subscription_status !== 'free' && 
            userData.subscription_expiry && 
            userData.subscription_expiry.toDate() < new Date()) {
            // Subscription expired, revert to free
            await updateDoc(userRef, {
                subscription_status: 'free',
                subscription_expiry: null
            });
            userData.subscription_status = 'free';
            userData.subscription_expiry = null;
        }
        
        res.status(200).json({
            user_id: userId,
            free_generations_remaining: userData.free_generations_remaining || 0,
            subscription_status: userData.subscription_status || 'free',
            subscription_expiry: userData.subscription_expiry ? userData.subscription_expiry.toDate() : null
        });
    } catch (err) {
        console.error('Error fetching user subscription:', err);
        res.status(500).json({ error: 'Server error' });
    }
});

// Subscribe user to a plan
app.post('/api/user/subscribe', async (req, res) => {
    const { userId, plan } = req.body;
    
    if (!userId || !plan) {
        return res.status(400).json({ error: 'User ID and plan are required' });
    }
    
    try {
        const userRef = doc(db, 'users', userId);
        const userSnap = await getDoc(userRef);
        
        let expiryDate = new Date();
        
        // Set expiry date based on plan
        switch(plan) {
            case 'monthly':
                expiryDate.setMonth(expiryDate.getMonth() + 1);
                break;
            case 'quarterly':
                expiryDate.setMonth(expiryDate.getMonth() + 3);
                break;
            case 'yearly':
                expiryDate.setFullYear(expiryDate.getFullYear() + 1);
                break;
            default:
                return res.status(400).json({ error: 'Invalid plan. Choose monthly, quarterly, or yearly.' });
        }
        
        // Create or update user record
        if (!userSnap.exists()) {
            await setDoc(userRef, {
                subscription_status: plan,
                subscription_expiry: Timestamp.fromDate(expiryDate),
                free_generations_remaining: 0,
                created_at: Timestamp.now()
            });
        } else {
            await updateDoc(userRef, {
                subscription_status: plan,
                subscription_expiry: Timestamp.fromDate(expiryDate)
            });
        }
        
        res.status(200).json({
            user_id: userId,
            message: 'Subscription successful',
            plan,
            subscription_expiry: expiryDate
        });
    } catch (err) {
        console.error('Error creating subscription:', err);
        res.status(500).json({ error: 'Server error' });
    }
});

// Upload PDF and generate questions and flashcards
app.post('/api/upload_pdf', upload.single('pdf'), async (req, res) => {
    if (!req.file) {
        return res.status(400).json({ error: 'No PDF file uploaded' });
    }

    const { user_id, content_name, num_questions = 10, num_options = 4, include_flashcards = true } = req.body;
    if (!user_id || !content_name) {
        return res.status(400).json({ error: 'user_id and content_name are required' });
    }

    // Check if user can generate content
    try {
        const usageStatus = await checkUserUsage(user_id);
        if (!usageStatus.canGenerate) {
            return res.status(403).json({ 
                error: 'Generation limit reached', 
                details: 'You have used all your free generations. Please subscribe to continue.',
                subscription_status: usageStatus.subscriptionStatus,
                remaining_free: usageStatus.remainingFree
            });
        }
        
        // Validate and limit the number of questions
        const numQuestions = Math.min(Math.max(parseInt(num_questions) || 10, 1), 50); // Min 1, Max 50 questions
        const numOptions = Math.min(Math.max(parseInt(num_options) || 4, 2), 6); // Min 2, Max 6 options

        // Extract text from PDF
        const pdfData = await pdfParse(req.file.buffer);
        const totalPages = pdfData.numpages;

        // Get page range from query parameters
        const startPage = parseInt(req.query.startPage) || 1;
        const endPage = parseInt(req.query.endPage) || totalPages;

        // Validate page range
        const start = Math.max(1, startPage);
        const end = Math.min(totalPages, endPage);

        if (start > end || start < 1 || end > totalPages) {
            return res.status(400).json({ 
                error: 'Invalid page range',
                totalPages,
                requestedRange: { start, end }
            });
        }

        // Extract text from the specified page range
        const text = pdfData.text.split('\n').slice((start - 1) * 50, end * 50).join('\n');

        // Generate questions and flashcards using Gemini API
        const content = await generateContent(text, 'multiple_choice', numOptions, numQuestions, include_flashcards === true);

        // Generate quiz ID and prepare data for database
        const quizId = generateQuizId();

        // Sanitize and validate questions
        const questions = content.questions.map(q => {
            if (!q.question || !q.type || !q.answer) {
                console.error('Invalid question structure:', q);
                throw new Error('Invalid question structure');
            }
            return {
                question: String(q.question),
                type: String(q.type),
                options: q.type.toLowerCase() === 'multiple_choice' 
                    ? (Array.isArray(q.options) ? q.options.map(String) : [])
                    : ['True', 'False'],
                answer: String(q.answer)
            };
        });

        // Sanitize and validate flashcards
        const flashcards = (content.flashcards || []).map(f => {
            if (!f.term || !f.definition) {
                console.error('Invalid flashcard structure:', f);
                throw new Error('Invalid flashcard structure');
            }
            return {
                term: String(f.term),
                definition: String(f.definition)
            };
        });

        // Prepare quiz data for database
        const quizData = {
            quiz_id: String(quizId),
            content_name: String(content_name),
            user_id: String(user_id),
            created_at: Timestamp.now(),
            source: 'pdf',
            pdf_details: {
                total_pages: totalPages,
                processed_pages: { start, end },
                num_questions: numQuestions,
                num_options: numOptions,
                include_flashcards
            },
            questions: questions,
            flashcards: flashcards
        };

        // Save to database
        const quizRef = collection(db, 'quizzes');
        await addDoc(quizRef, quizData);

        // Now decrement the free usage count if user is on free plan
        let remainingFree = usageStatus.remainingFree;
        if (usageStatus.subscriptionStatus === 'free') {
            remainingFree = await decrementFreeUsage(user_id);
        }

        res.status(201).json({ 
            message: 'Questions and flashcards generated successfully',
            user_id: user_id,
            quiz_id: quizId,
            quiz_link: `http://localhost:${process.env.PORT}/api/quiz/${quizId}`,
            content_name,
            pdf_details: {
                totalPages,
                processedPages: { start, end },
                numQuestions,
                numOptions,
                includeFlashcards: include_flashcards
            },
            subscription_status: usageStatus.subscriptionStatus,
            remaining_free: remainingFree,
            content: { questions, flashcards }
        });
    } catch (error) {
        console.error('Error processing PDF:', error);
        res.status(500).json({ 
            error: 'Error processing PDF', 
            details: error.message 
        });
    }
});

// Create Quiz/Flashcards
app.post('/api/create_content', async (req, res) => {
    const { text, question_type, num_options, num_questions, include_flashcards, content_name, user_id } = req.body;
    if (!text || !question_type || !content_name || !user_id) {
        return res.status(400).json({ error: 'Text, question_type, content_name, and user_id are required' });
    }
    
    // Check if user can generate content
    try {
        const usageStatus = await checkUserUsage(user_id);
        if (!usageStatus.canGenerate) {
            return res.status(403).json({ 
                error: 'Generation limit reached', 
                details: 'You have used all your free generations. Please subscribe to continue.',
                subscription_status: usageStatus.subscriptionStatus,
                remaining_free: usageStatus.remainingFree
            });
        }
        
        const numQuestions = Math.min(parseInt(num_questions) || 1, 10);
        const numOptions = Math.min(parseInt(num_options) || 4, 4);

        const content = await generateContent(text, question_type, numOptions, numQuestions, include_flashcards === true);
        const quizId = generateQuizId();
        
        // Sanitize and validate questions
        const questions = content.questions.map(q => {
            if (!q.question || !q.type || !q.answer) {
                console.error('Invalid question structure:', q);
                throw new Error('Invalid question structure');
            }
            return {
                question: String(q.question),
                type: String(q.type),
                options: q.type.toLowerCase() === 'multiple_choice' 
                    ? (Array.isArray(q.options) ? q.options.map(String) : [])
                    : ['True', 'False'],
                answer: String(q.answer)
            };
        });

        // Sanitize and validate flashcards
        const flashcards = (content.flashcards || []).map(f => {
            if (!f.term || !f.definition) {
                console.error('Invalid flashcard structure:', f);
                throw new Error('Invalid flashcard structure');
            }
            return {
                term: String(f.term),
                definition: String(f.definition)
            };
        });

        const quizData = {
            quiz_id: String(quizId),
            content_name: String(content_name),
            user_id: String(user_id),
            created_at: Timestamp.now(),
            questions: questions,
            flashcards: flashcards
        };

        const quizRef = collection(db, 'quizzes');
        await addDoc(quizRef, quizData);

        // Now decrement the free usage count if user is on free plan
        let remainingFree = usageStatus.remainingFree;
        if (usageStatus.subscriptionStatus === 'free') {
            remainingFree = await decrementFreeUsage(user_id);
        }

        res.status(201).json({ 
            user_id: user_id,
            quiz_id: quizId,
            quiz_link: `http://localhost:${process.env.PORT}/api/quiz/${quizId}`,
            content_name,
            subscription_status: usageStatus.subscriptionStatus,
            remaining_free: remainingFree,
            content: { questions, flashcards }
        });
    } catch (err) {
        console.error('Detailed error:', {
            message: err.message,
            stack: err.stack,
            code: err.code,
            details: err.details
        });
        res.status(500).json({ 
            error: 'Error saving content',
            details: err.message
        });
    }
});

// Get Quiz Data
app.get('/api/quiz/:quizId', async (req, res) => {
    const { quizId } = req.params;
    try {
        const quizRef = collection(db, 'quizzes');
        const q = query(quizRef, where('quiz_id', '==', quizId));
        const querySnapshot = await getDocs(q);
        
        if (!querySnapshot.empty) {
            const quizData = querySnapshot.docs[0].data();
            res.status(200).json({
                quiz_id: quizId,
                questions: quizData.questions,
                flashcards: quizData.flashcards
            });
        } else {
            res.status(404).json({ error: 'Quiz not found' });
        }
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Server error' });
    }
});

// Get Flashcard Data
app.get('/api/flashcards/:quizId', async (req, res) => {
    const { quizId } = req.params;
    try {
        const quizRef = collection(db, 'quizzes');
        const q = query(quizRef, where('quiz_id', '==', quizId));
        const querySnapshot = await getDocs(q);
        
        if (!querySnapshot.empty) {
            const quizData = querySnapshot.docs[0].data();
            res.status(200).json({
                quiz_id: quizId,
                flashcards: quizData.flashcards
            });
        } else {
            res.status(404).json({ error: 'Flashcards not found' });
        }
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Server error' });
    }
});

// Submit Score
app.post('/api/submit_score', async (req, res) => {
    const { quizId, playerName, score } = req.body;
    if (!quizId || !playerName || score === undefined) {
        return res.status(400).json({ error: 'Missing required fields: quizId, playerName, score' });
    }
    try {
        const scoreData = {
            quiz_id: String(quizId),
            player_name: String(playerName),
            score: Number(score),
            created_at: Timestamp.now()
        };

        const scoresRef = collection(db, 'scores');
        await addDoc(scoresRef, scoreData);
        
        res.status(201).json({ success: true, message: 'Score submitted successfully' });
    } catch (err) {
        console.error('Score submission error:', {
            message: err.message,
            stack: err.stack,
            code: err.code,
            details: err.details
        });
        res.status(500).json({ 
            error: 'Error saving score',
            details: err.message
        });
    }
});

// Get Leaderboard
app.get('/api/leaderboard/:quizId', async (req, res) => {
    const { quizId } = req.params;
    try {
        const scoresRef = collection(db, 'scores');
        const q = query(
            scoresRef,
            where('quiz_id', '==', quizId),
            orderBy('score', 'desc'),
            limit(10)
        );
        const querySnapshot = await getDocs(q);
        const leaderboard = querySnapshot.docs.map(doc => ({
            player_name: doc.data().player_name,
            score: doc.data().score
        }));
        
        res.status(200).json({
            quiz_id: quizId,
            leaderboard
        });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Server error' });
    }
});

// Get Global Recent Content (Public)
app.get('/api/recent', async (req, res) => {
    try {
        const quizRef = collection(db, 'quizzes');
        const q = query(quizRef, orderBy('created_at', 'desc'), limit(10));
        const querySnapshot = await getDocs(q);
        
        const recentContent = querySnapshot.docs.map(doc => ({
            quiz_id: doc.data().quiz_id,
            content_name: doc.data().content_name,
            created_at: doc.data().created_at.toDate()
        }));
        
        res.status(200).json(recentContent);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Error fetching recent content' });
    }
});

// Get User-Specific Recent Content
app.get('/api/recent/user/:userId', async (req, res) => {
    const { userId } = req.params;
    try {
        const quizRef = collection(db, 'quizzes');
        const q = query(
            quizRef,
            where('user_id', '==', userId),
            orderBy('created_at', 'desc'),
            limit(10)
        );
        const querySnapshot = await getDocs(q);
        
        const userContent = querySnapshot.docs.map(doc => ({
            quiz_id: doc.data().quiz_id,
            content_name: doc.data().content_name,
            created_at: doc.data().created_at.toDate()
        }));
        
        res.status(200).json(userContent);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Error fetching user recent content' });
    }
});

const PORT = process.env.PORT || 3000;

app.listen(PORT, "0.0.0.0", function () {
    console.log(`Server is running on port: ${PORT}`);
});

