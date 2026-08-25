const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const jwt = require('jsonwebtoken');
const fs = require('fs');
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

// ========== FILE-BASED STORAGE (بديل Firebase) ==========
const DATA_DIR = path.join(__dirname, 'data');
const QUESTIONS_FILE = path.join(DATA_DIR, 'questions.json');
const SUBMISSIONS_FILE = path.join(DATA_DIR, 'submissions.json');

// تأكد من وجود مجلد data
if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
}

// قراءة الأسئلة من الملف
function loadQuestions() {
    try {
        if (fs.existsSync(QUESTIONS_FILE)) {
            const data = fs.readFileSync(QUESTIONS_FILE, 'utf8');
            const parsed = JSON.parse(data);
            return parsed;
        }
    } catch (error) {
        console.error('Error loading questions:', error);
    }
    // بيانات افتراضية
    return [
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
}

// حفظ الأسئلة في الملف
function saveQuestions(questions) {
    try {
        fs.writeFileSync(QUESTIONS_FILE, JSON.stringify(questions, null, 2));
        return true;
    } catch (error) {
        console.error('Error saving questions:', error);
        return false;
    }
}

// قراءة النتائج من الملف
function loadSubmissions() {
    try {
        if (fs.existsSync(SUBMISSIONS_FILE)) {
            const data = fs.readFileSync(SUBMISSIONS_FILE, 'utf8');
            return JSON.parse(data);
        }
    } catch (error) {
        console.error('Error loading submissions:', error);
    }
    return [];
}

// حفظ النتائج في الملف
function saveSubmissions(submissions) {
    try {
        fs.writeFileSync(SUBMISSIONS_FILE, JSON.stringify(submissions, null, 2));
        return true;
    } catch (error) {
        console.error('Error saving submissions:', error);
        return false;
    }
}

// متغيرات للذاكرة
let questions = loadQuestions();
let submissions = loadSubmissions();
let nextId = questions.length > 0 ? Math.max(...questions.map(q => q.id)) + 1 : 1;

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
app.get('/api/questions', (req, res) => {
    // إعادة تحميل الأسئلة من الملف للتأكد من التحديث
    questions = loadQuestions();
    res.json(questions);
});

// إضافة سؤال جديد
app.post('/api/questions', authenticateToken, (req, res) => {
    try {
        const { text, options, correct } = req.body;

        if (!text || !options || options.length < 2) {
            return res.status(400).json({ error: 'Invalid question data' });
        }

        const newQuestion = {
            id: nextId++,
            text,
            options,
            correct: correct || 0
        };

        questions.push(newQuestion);
        saveQuestions(questions);

        res.json(newQuestion);
    } catch (error) {
        console.error('Add question error:', error);
        res.status(500).json({ error: error.message });
    }
});

// تعديل سؤال
app.put('/api/questions/:id', authenticateToken, (req, res) => {
    try {
        const id = parseInt(req.params.id);
        const { text, options, correct } = req.body;

        const index = questions.findIndex(q => q.id === id);
        if (index === -1) {
            return res.status(404).json({ error: 'Question not found' });
        }

        questions[index] = {
            ...questions[index],
            text: text || questions[index].text,
            options: options || questions[index].options,
            correct: correct !== undefined ? correct : questions[index].correct
        };

        saveQuestions(questions);
        res.json(questions[index]);
    } catch (error) {
        console.error('Update question error:', error);
        res.status(500).json({ error: error.message });
    }
});

// حذف سؤال
app.delete('/api/questions/:id', authenticateToken, (req, res) => {
    try {
        const id = parseInt(req.params.id);
        const index = questions.findIndex(q => q.id === id);

        if (index === -1) {
            return res.status(404).json({ error: 'Question not found' });
        }

        questions.splice(index, 1);
        saveQuestions(questions);

        res.json({ success: true, message: 'Question deleted' });
    } catch (error) {
        console.error('Delete question error:', error);
        res.status(500).json({ error: error.message });
    }
});

// إرسال الإجابات
app.post('/api/submit-answers', (req, res) => {
    try {
        const { userName, answers } = req.body;

        if (!userName || !answers) {
            return res.status(400).json({ error: 'Missing userName or answers' });
        }

        // تحميل الأسئلة الحالية
        questions = loadQuestions();

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

        submissions.push(submission);
        saveSubmissions(submissions);

        res.json(submission);
    } catch (error) {
        console.error('Submit answers error:', error);
        res.status(500).json({ error: error.message });
    }
});

// جلب النتائج (للداشبورد)
app.get('/api/submissions', authenticateToken, (req, res) => {
    try {
        submissions = loadSubmissions();
        res.json(submissions);
    } catch (error) {
        console.error('Get submissions error:', error);
        res.status(500).json({ error: error.message });
    }
});

// ========== تشغيل السيرفر ==========
app.listen(PORT, () => {
    console.log(`✅ Server running on http://localhost:${PORT}`);
    console.log(`📁 Data directory: ${DATA_DIR}`);
    console.log(`📝 Questions file: ${QUESTIONS_FILE}`);
    console.log(`📊 Submissions file: ${SUBMISSIONS_FILE}`);
});
