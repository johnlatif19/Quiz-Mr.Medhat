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

// ========== Firebase Initialization ==========
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
        console.log('Firebase initialized successfully');
    } else {
        console.warn('FIREBASE_CONFIG not found. Using in-memory storage');
    }
} catch (error) {
    console.error('Firebase initialization error:', error.message);
    console.warn('Falling back to in-memory storage');
}

// ========== IN-MEMORY FALLBACK ==========
let inMemoryData = {
    groups: [],
    exams: [],
    questions: [],
    submissions: []
};
let nextId = 1;

// ========== FUNCTIONS ==========

// === Groups ===
async function getGroups() {
    if (firestoreAvailable && db) {
        try {
            const snapshot = await db.collection('groups').orderBy('name').get();
            if (!snapshot.empty) {
                return snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
            }
        } catch (error) {
            console.error('Error fetching groups:', error);
        }
    }
    return inMemoryData.groups;
}

async function saveGroup(group) {
    if (firestoreAvailable && db) {
        try {
            const docRef = await db.collection('groups').add(group);
            return { id: docRef.id, ...group };
        } catch (error) {
            console.error('Error saving group:', error);
            return null;
        }
    }
    if (!group.id) group.id = nextId++;
    inMemoryData.groups.push(group);
    return group;
}

async function deleteGroup(id) {
    if (firestoreAvailable && db) {
        try {
            await db.collection('groups').doc(id).delete();
            return true;
        } catch (error) {
            console.error('Error deleting group:', error);
            return false;
        }
    }
    const index = inMemoryData.groups.findIndex(g => g.id == id);
    if (index !== -1) {
        inMemoryData.groups.splice(index, 1);
        return true;
    }
    return false;
}

async function getGroupBySlug(slug) {
    if (firestoreAvailable && db) {
        try {
            const snapshot = await db.collection('groups').where('slug', '==', slug).limit(1).get();
            if (!snapshot.empty) {
                const doc = snapshot.docs[0];
                return { id: doc.id, ...doc.data() };
            }
        } catch (error) {
            console.error('Error fetching group by slug:', error);
        }
    }
    return inMemoryData.groups.find(g => g.slug === slug);
}

// === Exams ===
async function getExams() {
    if (firestoreAvailable && db) {
        try {
            const snapshot = await db.collection('exams').orderBy('createdAt', 'desc').get();
            if (!snapshot.empty) {
                return snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
            }
        } catch (error) {
            console.error('Error fetching exams:', error);
        }
    }
    return inMemoryData.exams;
}

async function saveExam(exam) {
    if (firestoreAvailable && db) {
        try {
            const docRef = await db.collection('exams').add(exam);
            return { id: docRef.id, ...exam };
        } catch (error) {
            console.error('Error saving exam:', error);
            return null;
        }
    }
    if (!exam.id) exam.id = nextId++;
    inMemoryData.exams.push(exam);
    return exam;
}

async function deleteExam(id) {
    if (firestoreAvailable && db) {
        try {
            await db.collection('exams').doc(id).delete();
            return true;
        } catch (error) {
            console.error('Error deleting exam:', error);
            return false;
        }
    }
    const index = inMemoryData.exams.findIndex(e => e.id == id);
    if (index !== -1) {
        inMemoryData.exams.splice(index, 1);
        return true;
    }
    return false;
}

async function getExamByGroupSlug(slug) {
    if (firestoreAvailable && db) {
        try {
            console.log('Looking for exam with slug:', slug);
            const snapshot = await db.collection('exams')
                .where('groupSlug', '==', slug)
                .where('isPublished', '==', true)
                .limit(1)
                .get();
            if (!snapshot.empty) {
                const doc = snapshot.docs[0];
                const exam = { id: doc.id, ...doc.data() };
                console.log('Exam found:', exam.id);
                return exam;
            }
            console.log('No published exam found for slug:', slug);
        } catch (error) {
            console.error('Error fetching exam by slug:', error);
        }
    }
    return inMemoryData.exams.find(e => e.groupSlug === slug && e.isPublished);
}

async function updateExamPublish(id, isPublished) {
    if (firestoreAvailable && db) {
        try {
            await db.collection('exams').doc(id).update({ isPublished });
            return true;
        } catch (error) {
            console.error('Error updating exam publish status:', error);
            return false;
        }
    }
    const exam = inMemoryData.exams.find(e => e.id == id);
    if (exam) {
        exam.isPublished = isPublished;
        return true;
    }
    return false;
}

// === Questions ===
async function getQuestionsByExamId(examId) {
    console.log('getQuestionsByExamId called with examId:', examId);
    
    if (firestoreAvailable && db) {
        try {
            const snapshot = await db.collection('questions')
                .where('examId', '==', examId)
                .get();
            
            console.log('Firestore returned:', snapshot.size, 'questions');
            
            if (!snapshot.empty) {
                const questions = snapshot.docs.map(doc => ({ 
                    id: doc.id, 
                    ...doc.data() 
                }));
                questions.sort((a, b) => (a.id || 0) - (b.id || 0));
                console.log('Questions loaded:', questions.length);
                return questions;
            }
            
            console.log('No questions found with examId:', examId);
            return [];
        } catch (error) {
            console.error('Error in getQuestionsByExamId:', error);
            return [];
        }
    }
    
    console.log('Using in-memory questions');
    return inMemoryData.questions.filter(q => q.examId == examId);
}

async function saveQuestions(questions) {
    console.log('Saving questions:', questions.length);
    
    if (firestoreAvailable && db) {
        try {
            const batch = db.batch();
            const examId = questions[0]?.examId;
            
            if (examId) {
                const existing = await db.collection('questions')
                    .where('examId', '==', examId)
                    .get();
                existing.docs.forEach(doc => batch.delete(doc.ref));
                console.log('Deleted', existing.size, 'old questions');
            }
            
            questions.forEach((q, index) => {
                const docRef = db.collection('questions').doc();
                const data = {
                    ...q,
                    id: index + 1,
                    examId: examId
                };
                batch.set(docRef, data);
                console.log('Adding question', index + 1, ':', data.text);
            });
            
            await batch.commit();
            console.log('Questions saved successfully');
            return true;
        } catch (error) {
            console.error('Error saving questions:', error);
            return false;
        }
    }
    
    inMemoryData.questions = inMemoryData.questions.filter(q => q.examId != questions[0]?.examId);
    questions.forEach(q => {
        if (!q.id) q.id = nextId++;
        inMemoryData.questions.push(q);
    });
    return true;
}

async function deleteQuestionsByExamId(examId) {
    if (firestoreAvailable && db) {
        try {
            const snapshot = await db.collection('questions').where('examId', '==', examId).get();
            const batch = db.batch();
            snapshot.docs.forEach(doc => batch.delete(doc.ref));
            await batch.commit();
            return true;
        } catch (error) {
            console.error('Error deleting questions:', error);
            return false;
        }
    }
    inMemoryData.questions = inMemoryData.questions.filter(q => q.examId != examId);
    return true;
}

// === Submissions ===
async function getSubmissions() {
    if (firestoreAvailable && db) {
        try {
            const snapshot = await db.collection('submissions')
                .orderBy('timestamp', 'desc')
                .get();
            if (!snapshot.empty) {
                return snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
            }
        } catch (error) {
            console.error('Error fetching submissions:', error);
        }
    }
    return inMemoryData.submissions;
}

async function saveSubmission(submission) {
    if (firestoreAvailable && db) {
        try {
            const docRef = await db.collection('submissions').add(submission);
            return { id: docRef.id, ...submission };
        } catch (error) {
            console.error('Error saving submission:', error);
            return null;
        }
    }
    if (!submission.id) submission.id = nextId++;
    inMemoryData.submissions.push(submission);
    return submission;
}

async function deleteSubmission(id) {
    if (firestoreAvailable && db) {
        try {
            await db.collection('submissions').doc(id).delete();
            return true;
        } catch (error) {
            console.error('Error deleting submission:', error);
            return false;
        }
    }
    const index = inMemoryData.submissions.findIndex(s => s.id == id);
    if (index !== -1) {
        inMemoryData.submissions.splice(index, 1);
        return true;
    }
    return false;
}

async function checkStudentAttempt(groupSlug, studentName) {
    if (firestoreAvailable && db) {
        try {
            const snapshot = await db.collection('submissions')
                .where('groupSlug', '==', groupSlug)
                .where('studentName', '==', studentName)
                .get();
            return !snapshot.empty;
        } catch (error) {
            console.error('Error checking attempt:', error);
            return false;
        }
    }
    return inMemoryData.submissions.some(s => s.groupSlug === groupSlug && s.studentName === studentName);
}

// ========== MIDDLEWARE ==========
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

// === Login ===
app.post('/api/login', (req, res) => {
    const { username, password } = req.body;
    if (username === ADMIN_USERNAME && password === ADMIN_PASSWORD) {
        const token = jwt.sign({ username, role: 'admin' }, JWT_SECRET, { expiresIn: '24h' });
        res.json({ success: true, token });
    } else {
        res.status(401).json({ error: 'Invalid credentials' });
    }
});

// === Groups ===
app.get('/api/groups', authenticateToken, async (req, res) => {
    try {
        const groups = await getGroups();
        res.json(groups);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.post('/api/groups', authenticateToken, async (req, res) => {
    try {
        const { name } = req.body;
        if (!name) return res.status(400).json({ error: 'Group name required' });
        
        const slug = name.toLowerCase().trim().replace(/\s+/g, '-');
        
        const existing = await getGroupBySlug(slug);
        if (existing) {
            return res.status(400).json({ error: 'Group with this name already exists' });
        }
        
        const group = { name, slug, createdAt: new Date().toISOString() };
        const saved = await saveGroup(group);
        res.json(saved);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.delete('/api/groups/:id', authenticateToken, async (req, res) => {
    try {
        const deleted = await deleteGroup(req.params.id);
        res.json({ success: deleted });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// === Check if group exists ===
app.get('/api/group/:slug', async (req, res) => {
    try {
        const { slug } = req.params;
        const group = await getGroupBySlug(slug);
        if (group) {
            res.json({ exists: true, group });
        } else {
            res.status(404).json({ exists: false });
        }
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// === Exams ===
app.get('/api/exams', authenticateToken, async (req, res) => {
    try {
        const exams = await getExams();
        const groups = await getGroups();
        const examsWithGroups = exams.map(exam => {
            const group = groups.find(g => g.id === exam.groupId);
            return { ...exam, groupName: group?.name || 'Unknown' };
        });
        res.json(examsWithGroups);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.post('/api/exams', authenticateToken, async (req, res) => {
    try {
        const { groupId, groupSlug, questions } = req.body;
        if (!groupId || !questions || questions.length === 0) {
            return res.status(400).json({ error: 'Group ID and questions required' });
        }

        const exam = {
            groupId,
            groupSlug,
            questionsCount: questions.length,
            isPublished: true,
            createdAt: new Date().toISOString()
        };

        const savedExam = await saveExam(exam);
        if (savedExam) {
            const examQuestions = questions.map((q, idx) => ({
                ...q,
                id: idx + 1,
                examId: savedExam.id
            }));
            await saveQuestions(examQuestions);
            res.json(savedExam);
        } else {
            res.status(500).json({ error: 'Failed to save exam' });
        }
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.put('/api/exams/:id/publish', authenticateToken, async (req, res) => {
    try {
        const id = req.params.id;
        const updated = await updateExamPublish(id, true);
        if (updated) {
            res.json({ success: true });
        } else {
            res.status(404).json({ error: 'Exam not found' });
        }
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.delete('/api/exams/:id', authenticateToken, async (req, res) => {
    try {
        await deleteQuestionsByExamId(req.params.id);
        await deleteExam(req.params.id);
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// === Edit exam questions ===
app.put('/api/exams/:id/questions', authenticateToken, async (req, res) => {
    try {
        const examId = req.params.id;
        const { questions } = req.body;
        
        if (!questions || questions.length === 0) {
            return res.status(400).json({ error: 'No questions provided' });
        }

        // Delete old questions
        await deleteQuestionsByExamId(examId);
        
        // Add new questions
        const examQuestions = questions.map((q, idx) => ({
            ...q,
            id: idx + 1,
            examId: examId
        }));
        
        const saved = await saveQuestions(examQuestions);
        if (saved) {
            // Update question count in exam
            if (firestoreAvailable && db) {
                await db.collection('exams').doc(examId).update({ questionsCount: questions.length });
            } else {
                const exam = inMemoryData.exams.find(e => e.id == examId);
                if (exam) exam.questionsCount = questions.length;
            }
            res.json({ success: true });
        } else {
            res.status(500).json({ error: 'Failed to save questions' });
        }
    } catch (error) {
        console.error('Error updating exam questions:', error);
        res.status(500).json({ error: error.message });
    }
});

// === Delete single question ===
app.delete('/api/questions/:id', authenticateToken, async (req, res) => {
    try {
        const questionId = req.params.id;
        if (firestoreAvailable && db) {
            await db.collection('questions').doc(questionId).delete();
        } else {
            const index = inMemoryData.questions.findIndex(q => q.id == questionId);
            if (index !== -1) inMemoryData.questions.splice(index, 1);
        }
        res.json({ success: true });
    } catch (error) {
        console.error('Error deleting question:', error);
        res.status(500).json({ error: error.message });
    }
});

// === Student Exam ===
app.get('/api/exam/:slug', async (req, res) => {
    try {
        const { slug } = req.params;
        console.log('Looking for exam with slug:', slug);
        
        const group = await getGroupBySlug(slug);
        if (!group) {
            console.log('Group not found:', slug);
            return res.status(404).json({ error: 'Group not found' });
        }
        console.log('Group found:', group.name);
        
        const exam = await getExamByGroupSlug(slug);
        if (!exam) {
            console.log('Exam not found or not published for slug:', slug);
            return res.status(404).json({ error: 'Exam not found or not published' });
        }
        console.log('Exam found:', exam.id, 'isPublished:', exam.isPublished);
        
        const questions = await getQuestionsByExamId(exam.id);
        console.log('Questions returned:', questions.length);
        
        res.json({ exam, questions });
    } catch (error) {
        console.error('Error in /api/exam/:slug:', error);
        res.status(500).json({ error: error.message });
    }
});

app.post('/api/submit-exam', async (req, res) => {
    try {
        const { groupSlug, studentName, answers } = req.body;
        
        if (!groupSlug || !studentName || !answers) {
            return res.status(400).json({ error: 'Missing required fields' });
        }

        const hasAttempted = await checkStudentAttempt(groupSlug, studentName);
        if (hasAttempted) {
            return res.status(409).json({ error: 'You have already taken this exam' });
        }

        const exam = await getExamByGroupSlug(groupSlug);
        if (!exam) {
            return res.status(404).json({ error: 'Exam not found' });
        }

        const questions = await getQuestionsByExamId(exam.id);
        let correctCount = 0;
        const results = [];

        questions.forEach((q, idx) => {
            const userAnswer = answers[idx] !== undefined ? answers[idx] : null;
            const isCorrect = userAnswer === q.correct;
            if (isCorrect) correctCount++;
            results.push({
                questionId: q.id,
                questionText: q.text,
                options: q.options,
                userAnswer,
                correctAnswer: q.correct,
                isCorrect
            });
        });

        const submission = {
            groupSlug,
            groupId: exam.groupId,
            studentName,
            timestamp: new Date().toISOString(),
            total: questions.length,
            correct: correctCount,
            score: Math.round((correctCount / questions.length) * 100),
            results
        };

        const saved = await saveSubmission(submission);
        res.json({ success: true, submission: saved });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// === Submissions (Admin) ===
app.get('/api/submissions', authenticateToken, async (req, res) => {
    try {
        const submissions = await getSubmissions();
        res.json(submissions);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.delete('/api/submissions/:id', authenticateToken, async (req, res) => {
    try {
        const deleted = await deleteSubmission(req.params.id);
        res.json({ success: deleted });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// ========== FRONTEND ROUTES ==========

// Home page - shows 404
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Group page - passes slug to frontend
app.get('/:groupSlug', (req, res) => {
    const slug = req.params.groupSlug;
    
    // Exclude special paths
    const reservedPaths = ['login', 'dashboard', 'api', 'favicon.ico', 'robots.txt'];
    if (reservedPaths.includes(slug) || slug.includes('.')) {
        return res.sendFile(path.join(__dirname, 'public', 'index.html'));
    }
    
    // Pass slug to frontend by sending index.html
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ========== START SERVER ==========
app.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
    console.log(`Firebase: ${firestoreAvailable ? 'Connected' : 'Not connected (using in-memory)'}`);
});
