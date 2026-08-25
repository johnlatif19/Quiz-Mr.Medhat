const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const jwt = require('jsonwebtoken');
const admin = require('firebase-admin');
const path = require('path');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(bodyParser.json());
app.use(express.static('public'));

// JWT Secret
const JWT_SECRET = process.env.JWT_SECRET || 'fallback_secret_123456789';
const ADMIN_USERNAME = process.env.ADMIN_USERNAME || 'admin';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin123';

// ========== تهيئة Firebase ==========
let db = null;
let firestoreAvailable = false;

try {
    if (process.env.FIREBASE_CONFIG) {
        const firebaseConfig = JSON.parse(process.env.FIREBASE_CONFIG);
        admin.initializeApp({
            credential: admin.credential.cert(firebaseConfig),
            databaseURL: `https://${firebaseConfig.project_id}.firebaseio.com`
        });
        db = admin.firestore();
        firestoreAvailable = true;
        console.log('🔥 Firebase initialized successfully');
    } else {
        console.warn('⚠️ FIREBASE_CONFIG not found. Using in-memory storage (not recommended for production)');
    }
} catch (error) {
    console.error('❌ Firebase initialization error:', error.message);
    console.warn('⚠️ Falling back to in-memory storage');
}

// ========== IN-MEMORY FALLBACK (في حالة عدم وجود Firebase) ==========
let inMemoryQuestions = [
    {
        id: 1,
        text: '"The disabled need care" - "The disabled" functions as:',
        options: ['Singular noun', 'Plural noun', 'Adjective only', 'Adverb'],
        correct: 1
    },
    {
        id: 2,
        text: '"It isn\'t my car, Mine is red" - The underlined words are:',
        options: ['Subject pronoun + Object pronoun', 'Possessive adjective + Possessive pronoun', 'Object pronoun + Subject pronoun', 'Two nouns'],
        correct: 1
    }
];
let inMemorySubmissions = [];
let nextId = 3;

// ========== FUNCTIONS ==========

// جلب كل الأسئلة
async function getQuestions() {
    if (firestoreAvailable && db) {
        try {
            const snapshot = await db.collection('questions').orderBy('id').get();
            if (!snapshot.empty) {
                return snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
            }
        } catch (error) {
            console.error('Error fetching questions from Firestore:', error);
        }
    }
    return inMemoryQuestions;
}

// حفظ أو تحديث سؤال
async function saveQuestionToDb(question) {
    if (firestoreAvailable && db) {
        try {
            // نبحث عن السؤال في Firestore
            const snapshot = await db.collection('questions').where('id', '==', question.id).get();
            if (!snapshot.empty) {
                // تحديث
                const docRef = snapshot.docs[0].ref;
                await docRef.update(question);
                return question;
            } else {
                // إضافة جديد
                const docRef = await db.collection('questions').add(question);
                return { id: docRef.id, ...question };
            }
        } catch (error) {
            console.error('Error saving question to Firestore:', error);
            return null;
        }
    }
    // Fallback to in-memory
    const existing = inMemoryQuestions.find(q => q.id === question.id);
    if (existing) {
        Object.assign(existing, question);
        return existing;
    } else {
        if (!question.id) {
            question.id = nextId++;
        }
        inMemoryQuestions.push(question);
        return question;
    }
}

// حذف سؤال
async function deleteQuestionFromDb(id) {
    if (firestoreAvailable && db) {
        try {
            const snapshot = await db.collection('questions').where('id', '==', parseInt(id)).get();
            if (!snapshot.empty) {
                const docRef = snapshot.docs[0].ref;
                await docRef.delete();
                return true;
            }
            return false;
        } catch (error) {
            console.error('Error deleting question from Firestore:', error);
            return false;
        }
    }
    // Fallback
    const index = inMemoryQuestions.findIndex(q => q.id == id);
    if (index !== -1) {
        inMemoryQuestions.splice(index, 1);
        return true;
    }
    return false;
}

// حفظ نتيجة اختبار
async function saveSubmission(submission) {
    if (firestoreAvailable && db) {
        try {
            const docRef = await db.collection('submissions').add(submission);
            return { id: docRef.id, ...submission };
        } catch (error) {
            console.error('Error saving submission to Firestore:', error);
            return null;
        }
    }
    inMemorySubmissions.push(submission);
    return submission;
}

// جلب كل النتائج
async function getSubmissions() {
    if (firestoreAvailable && db) {
        try {
            const snapshot = await db.collection('submissions').orderBy('timestamp', 'desc').get();
            if (!snapshot.empty) {
                return snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
            }
        } catch (error) {
            console.error('Error fetching submissions from Firestore:', error);
        }
    }
    return inMemorySubmissions;
}

// ========== MIDDLEWARE: التحقق من JWT ==========
function authenticateToken(req, res, next) {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];

    if (!token) {
        return res.status(401).json({ error: 'Access denied. No token provided.' });
    }

    try {
        const decoded = jwt.verify(token, JWT_SECRET);
        req.user = decoded;
        next();
    } catch (error) {
        return res.status(403).json({ error: 'Invalid or expired token.' });
    }
}

// ========== ROUTES ==========

// تسجيل الدخول
app.post('/api/login', (req, res) => {
    const { username, password } = req.body;

    if (username === ADMIN_USERNAME && password === ADMIN_PASSWORD) {
        const token = jwt.sign({ username, role: 'admin' }, JWT_SECRET, { expiresIn: '24h' });
        res.json({ success: true, token });
    } else {
        res.status(401).json({ error: 'Invalid credentials' });
    }
});

// جلب كل الأسئلة
app.get('/api/questions', async (req, res) => {
    try {
        const questions = await getQuestions();
        res.json(questions);
    } catch (error) {
        console.error('Error in /api/questions:', error);
        res.status(500).json({ error: error.message });
    }
});

// إضافة سؤال جديد
app.post('/api/questions', authenticateToken, async (req, res) => {
    try {
        const { text, options, correct } = req.body;

        if (!text || !options || options.length < 2) {
            return res.status(400).json({ error: 'Invalid question data' });
        }

        // جلب الأسئلة الحالية لتحديد الـ id
        const currentQuestions = await getQuestions();
        const maxId = currentQuestions.reduce((max, q) => Math.max(max, q.id || 0), 0);

        const newQuestion = {
            id: maxId + 1,
            text,
            options,
            correct: correct || 0
        };

        const saved = await saveQuestionToDb(newQuestion);
        res.json(saved || newQuestion);
    } catch (error) {
        console.error('Add question error:', error);
        res.status(500).json({ error: error.message });
    }
});

// تعديل سؤال
app.put('/api/questions/:id', authenticateToken, async (req, res) => {
    try {
        const id = parseInt(req.params.id);
        const { text, options, correct } = req.body;

        const updatedQuestion = {
            id,
            text: text,
            options: options,
            correct: correct
        };

        const saved = await saveQuestionToDb(updatedQuestion);
        if (saved) {
            res.json(saved);
        } else {
            res.status(404).json({ error: 'Question not found' });
        }
    } catch (error) {
        console.error('Update question error:', error);
        res.status(500).json({ error: error.message });
    }
});

// حذف سؤال
app.delete('/api/questions/:id', authenticateToken, async (req, res) => {
    try {
        const id = req.params.id;
        const deleted = await deleteQuestionFromDb(id);
        if (deleted) {
            res.json({ success: true, message: 'Question deleted' });
        } else {
            res.status(404).json({ error: 'Question not found' });
        }
    } catch (error) {
        console.error('Delete question error:', error);
        res.status(500).json({ error: error.message });
    }
});

// إرسال الإجابات
app.post('/api/submit-answers', async (req, res) => {
    try {
        const { userName, answers } = req.body;

        if (!userName || !answers) {
            return res.status(400).json({ error: 'Missing userName or answers' });
        }

        const questions = await getQuestions();
        let correctCount = 0;
        const results = [];

        questions.forEach((q, idx) => {
            const userAnswer = answers[idx] !== undefined ? answers[idx] : null;
            const isCorrect = userAnswer === q.correct;
            if (isCorrect) correctCount++;
            results.push({
                questionId: q.id,
                userAnswer,
                correctAnswer: q.correct,
                isCorrect
            });
        });

        const submission = {
            userName,
            timestamp: new Date().toISOString(),
            total: questions.length,
            correct: correctCount,
            score: Math.round((correctCount / questions.length) * 100),
            results
        };

        await saveSubmission(submission);
        res.json(submission);
    } catch (error) {
        console.error('Submit answers error:', error);
        res.status(500).json({ error: error.message });
    }
});

// جلب النتائج (للداشبورد)
app.get('/api/submissions', authenticateToken, async (req, res) => {
    try {
        const submissions = await getSubmissions();
        res.json(submissions);
    } catch (error) {
        console.error('Get submissions error:', error);
        res.status(500).json({ error: error.message });
    }
});

// ========== تشغيل السيرفر ==========
app.listen(PORT, () => {
    console.log(`✅ Server running on http://localhost:${PORT}`);
    console.log(`📁 Firebase: ${firestoreAvailable ? '✅ Connected' : '❌ Not connected (using in-memory)'}`);
});
