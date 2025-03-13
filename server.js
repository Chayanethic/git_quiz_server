require('dotenv').config();
const express = require('express');
const { db } = require('./firebase');
const { collection, doc, addDoc, getDoc, getDocs, query, where, orderBy, limit, Timestamp } = require('firebase/firestore');
const { GoogleGenerativeAI } = require('@google/generative-ai');


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

// Create Quiz/Flashcards
app.post('/api/create_content', async (req, res) => {
    const { text, question_type, num_options, num_questions, include_flashcards, content_name, user_id } = req.body;
    if (!text || !question_type || !content_name || !user_id) {
        return res.status(400).json({ error: 'Text, question_type, content_name, and user_id are required' });
    }
    const numQuestions = Math.min(parseInt(num_questions) || 1, 10);
    const numOptions = Math.min(parseInt(num_options) || 4, 4);

    try {
        console.log('Generating content with parameters:', {
            text: text.substring(0, 50) + '...',
            question_type,
            numOptions,
            numQuestions,
            include_flashcards
        });

        const content = await generateContent(text, question_type, numOptions, numQuestions, include_flashcards === true);
        console.log('Generated content structure:', JSON.stringify(content, null, 2));

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

        console.log('Attempting to save quiz data:', JSON.stringify(quizData, null, 2));

        const quizRef = collection(db, 'quizzes');
        await addDoc(quizRef, quizData);

        res.status(201).json({ 
            quiz_id: quizId,
            quiz_link: `http://localhost:${process.env.PORT}/api/quiz/${quizId}`,
            content_name,
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
        console.log('Attempting to save score:', {
            quiz_id: quizId,
            player_name: playerName,
            score: score
        });

        const scoreData = {
            quiz_id: String(quizId),
            player_name: String(playerName),
            score: Number(score),
            created_at: Timestamp.now()
        };

        console.log('Formatted score data:', scoreData);

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

// // Root endpoint
// app.get('/', (req, res) => {
//     res.status(200).json({ message: 'Welcome to the Quiz API', version: '1.0' });
// });

const PORT = process.env.PORT || 3000;

app.get("/", (req, res) => {
    res.send(`Hello from Express on Vercel!${PORT}`);
  });
app.listen(PORT, "0.0.0.0", function () {
    console.log(`Server is running on port: ${PORT}`);
  });

