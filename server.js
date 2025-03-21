require('dotenv').config();
const express = require('express');
const { db } = require('./firebase');
const { collection, doc, addDoc, getDoc, getDocs, query, where, orderBy, limit, Timestamp, updateDoc, setDoc } = require('firebase/firestore');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const multer = require('multer');
const pdfParse = require('pdf-parse');
const PDFDocument = require('pdfkit');
const fs = require('fs');
const path = require('path');

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

// Ensure uploads directory exists
const uploadsDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadsDir)) {
    fs.mkdirSync(uploadsDir);
}

// Generate mock test questions using Gemini
const generateMockTest = async (topic, description, difficulty, numQuestions) => {
    try {
        const prompt = `
Generate a mock test with exactly ${numQuestions} questions for the following topic:
Topic: "${topic}"
Description: "${description}"
Difficulty Level: "${difficulty}"

The questions should be challenging and appropriate for the specified difficulty level.
Return in JSON format with no extra text:
{
    "mock_test": {
        "topic": "${topic}",
        "difficulty": "${difficulty}",
        "total_questions": ${numQuestions},
        "time_allowed": "${Math.ceil(numQuestions * 2)} minutes",
        "questions": [
            {
                "question_number": 1,
                "question": "question text",
                "options": ["A) option1", "B) option2", "C) option3", "D) option4"],
                "correct_answer": "A",
                "explanation": "detailed explanation"
            }
        ]
    }
}`;

        const result = await model.generateContent(prompt);
        const responseText = result.response.text().replace(/```json/g, '').replace(/```/g, '').trim();
        return JSON.parse(responseText);
    } catch (error) {
        console.error('Error generating mock test:', error);
        throw error;
    }
};

// Create PDF from mock test data
const createMockTestPDF = async (mockTestData, filePath) => {
    return new Promise((resolve, reject) => {
        try {
            const doc = new PDFDocument();
            const stream = fs.createWriteStream(filePath);

            doc.pipe(stream);

            // Add title
            doc.fontSize(20).text('Mock Test', { align: 'center' });
            doc.moveDown();

            // Add test details
            doc.fontSize(12);
            doc.text(`Topic: ${mockTestData.mock_test.topic}`);
            doc.text(`Difficulty: ${mockTestData.mock_test.difficulty}`);
            doc.text(`Total Questions: ${mockTestData.mock_test.total_questions}`);
            doc.text(`Time Allowed: ${mockTestData.mock_test.time_allowed}`);
            doc.moveDown();

            // Add instructions
            doc.fontSize(14).text('Instructions:', { underline: true });
            doc.fontSize(12)
                .text('1. Attempt all questions')
                .text('2. Each question carries equal marks')
                .text(`3. Time allowed: ${mockTestData.mock_test.time_allowed}`);
            doc.moveDown();

            // Add questions
            mockTestData.mock_test.questions.forEach((q, index) => {
                doc.fontSize(12).text(`${index + 1}. ${q.question}`);
                doc.moveDown(0.5);
                q.options.forEach(option => {
                    doc.text(option);
                });
                doc.moveDown();
            });

            // Add answer key (separate page)
            doc.addPage();
            doc.fontSize(16).text('Answer Key', { align: 'center' });
            doc.moveDown();
            mockTestData.mock_test.questions.forEach((q, index) => {
                doc.fontSize(12)
                    .text(`${index + 1}. Correct Answer: ${q.correct_answer}`)
                    .text(`Explanation: ${q.explanation}`)
                    .moveDown();
            });

            doc.end();

            stream.on('finish', () => {
                resolve(filePath);
            });

            stream.on('error', reject);
        } catch (error) {
            reject(error);
        }
    });
};

// Generate Mock Test API
app.post('/api/mock-test/generate', async (req, res) => {
    const { topic, description, difficulty, num_questions, user_id } = req.body;

    if (!topic || !description || !difficulty || !num_questions || !user_id) {
        return res.status(400).json({
            error: 'Missing required fields',
            required: ['topic', 'description', 'difficulty', 'num_questions', 'user_id']
        });
    }

    try {
        // Check user usage/subscription
        const usageStatus = await checkUserUsage(user_id);
        if (!usageStatus.canGenerate) {
            return res.status(403).json({
                error: 'Generation limit reached',
                details: 'You have used all your free generations. Please subscribe to continue.',
                subscription_status: usageStatus.subscriptionStatus,
                remaining_free: usageStatus.remainingFree
            });
        }

        // Generate mock test questions
        const mockTestData = await generateMockTest(
            topic,
            description,
            difficulty,
            Math.min(Math.max(parseInt(num_questions) || 10, 5), 50) // Min 5, Max 50 questions
        );

        // Generate unique test ID
        const testId = generateQuizId();
        const pdfFileName = `mock_test_${testId}.pdf`;
        const pdfFilePath = path.join(uploadsDir, pdfFileName);

        // Create PDF
        await createMockTestPDF(mockTestData, pdfFilePath);

        // Save mock test data to database
        const mockTestRef = collection(db, 'mock_tests');
        await addDoc(mockTestRef, {
            test_id: testId,
            user_id: String(user_id),
            topic: String(topic),
            difficulty: String(difficulty),
            num_questions: Number(num_questions),
            created_at: Timestamp.now(),
            test_data: mockTestData.mock_test,
            pdf_path: pdfFileName
        });

        // Decrement free usage if applicable
        let remainingFree = usageStatus.remainingFree;
        if (usageStatus.subscriptionStatus === 'free') {
            remainingFree = await decrementFreeUsage(user_id);
        }

        res.status(201).json({
            message: 'Mock test generated successfully',
            test_id: testId,
            download_link: `/api/mock-test/download/${testId}`,
            topic,
            difficulty,
            num_questions,
            subscription_status: usageStatus.subscriptionStatus,
            remaining_free: remainingFree
        });
    } catch (error) {
        console.error('Error generating mock test:', error);
        res.status(500).json({
            error: 'Error generating mock test',
            details: error.message
        });
    }
});

// Download Mock Test PDF
app.get('/api/mock-test/download/:testId', async (req, res) => {
    const { testId } = req.params;
    try {
        // Get mock test data from database
        const mockTestRef = collection(db, 'mock_tests');
        const q = query(mockTestRef, where('test_id', '==', testId));
        const querySnapshot = await getDocs(q);

        if (querySnapshot.empty) {
            return res.status(404).json({ error: 'Mock test not found' });
        }

        const mockTestDoc = querySnapshot.docs[0].data();
        const pdfPath = path.join(uploadsDir, mockTestDoc.pdf_path);

        if (!fs.existsSync(pdfPath)) {
            return res.status(404).json({ error: 'PDF file not found' });
        }

        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Disposition', `attachment; filename=mock_test_${testId}.pdf`);

        const fileStream = fs.createReadStream(pdfPath);
        fileStream.pipe(res);
    } catch (error) {
        console.error('Error downloading mock test:', error);
        res.status(500).json({
            error: 'Error downloading mock test',
            details: error.message
        });
    }
});

// Get User's Mock Tests
app.get('/api/mock-test/user/:userId', async (req, res) => {
    const { userId } = req.params;
    try {
        const mockTestRef = collection(db, 'mock_tests');
        const q = query(
            mockTestRef,
            where('user_id', '==', userId),
            orderBy('created_at', 'desc'),
            limit(10)
        );
        const querySnapshot = await getDocs(q);

        const mockTests = querySnapshot.docs.map(doc => ({
            test_id: doc.data().test_id,
            topic: doc.data().topic,
            difficulty: doc.data().difficulty,
            num_questions: doc.data().num_questions,
            created_at: doc.data().created_at.toDate(),
            download_link: `/api/mock-test/download/${doc.data().test_id}`
        }));

        res.status(200).json(mockTests);
    } catch (error) {
        console.error('Error fetching user mock tests:', error);
        res.status(500).json({
            error: 'Error fetching mock tests',
            details: error.message
        });
    }
});

const PORT = process.env.PORT || 3000;

app.listen(PORT, "0.0.0.0", function () {
    console.log(`Server is running on port: ${PORT}`);
});

