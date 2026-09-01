const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const jwt = require('jsonwebtoken');
const admin = require('firebase-admin');
const path = require('path');
const multer = require('multer');
const fs = require('fs');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

// ====== إعداد Multer لرفع الصور ======
const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 5 * 1024 * 1024 }, // 5MB
    fileFilter: (req, file, cb) => {
        if (file.mimetype.startsWith('image/')) {
            cb(null, true);
        } else {
            cb(new Error('Only images are allowed'));
        }
    }
});

// Middleware
app.use(cors());
app.use(bodyParser.json({ limit: '50mb' }));
app.use(bodyParser.urlencoded({ extended: true, limit: '50mb' }));
app.use(express.static('public'));

// ====== مسارات إضافية للواجهة ======
app.get('/upload-exam', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'upload-exam.html'));
});

app.get('/upload-image-exam', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'upload-image-exam.html'));
});

// ====== صفحة تحويل الصور إلى أسئلة (OCR) ======
app.get('/upload-ocr-exam', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'upload-ocr-exam.html'));
});

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
    submissions: [],
    cheats: [],
    examImages: []
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

async function getGroupById(id) {
    if (firestoreAvailable && db) {
        try {
            const doc = await db.collection('groups').doc(id).get();
            if (doc.exists) {
                return { id: doc.id, ...doc.data() };
            }
        } catch (error) {
            console.error('Error fetching group by id:', error);
        }
    }
    return inMemoryData.groups.find(g => g.id == id);
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

async function getExamById(id) {
    if (firestoreAvailable && db) {
        try {
            const doc = await db.collection('exams').doc(id).get();
            if (doc.exists) {
                return { id: doc.id, ...doc.data() };
            }
        } catch (error) {
            console.error('Error fetching exam by id:', error);
        }
    }
    return inMemoryData.exams.find(e => e.id == id);
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

async function updateExamGroup(id, groupId, groupSlug) {
    if (firestoreAvailable && db) {
        try {
            await db.collection('exams').doc(id).update({ groupId, groupSlug });
            return true;
        } catch (error) {
            console.error('Error updating exam group:', error);
            return false;
        }
    }
    const exam = inMemoryData.exams.find(e => e.id == id);
    if (exam) {
        exam.groupId = groupId;
        exam.groupSlug = groupSlug;
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

async function deleteSingleQuestion(id) {
    if (firestoreAvailable && db) {
        try {
            await db.collection('questions').doc(id).delete();
            return true;
        } catch (error) {
            console.error('Error deleting question:', error);
            return false;
        }
    }
    const index = inMemoryData.questions.findIndex(q => q.id == id);
    if (index !== -1) {
        inMemoryData.questions.splice(index, 1);
        return true;
    }
    return false;
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

// === Cheat Reports ===
async function saveCheatReport(report) {
    if (firestoreAvailable && db) {
        try {
            const docRef = await db.collection('cheats').add({
                ...report,
                timestamp: report.timestamp || new Date().toISOString()
            });
            return { id: docRef.id, ...report };
        } catch (error) {
            console.error('Error saving cheat report:', error);
            return null;
        }
    }
    report.id = nextId++;
    inMemoryData.cheats.push(report);
    return report;
}

async function getCheatReports() {
    if (firestoreAvailable && db) {
        try {
            const snapshot = await db.collection('cheats')
                .orderBy('timestamp', 'desc')
                .get();
            if (!snapshot.empty) {
                return snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
            }
        } catch (error) {
            console.error('Error fetching cheat reports:', error);
        }
    }
    return inMemoryData.cheats;
}

async function clearCheatReports() {
    if (firestoreAvailable && db) {
        try {
            const snapshot = await db.collection('cheats').get();
            const batch = db.batch();
            snapshot.docs.forEach(doc => batch.delete(doc.ref));
            await batch.commit();
            return true;
        } catch (error) {
            console.error('Error clearing cheat reports:', error);
            return false;
        }
    }
    inMemoryData.cheats = [];
    return true;
}

// ====== EXAM IMAGES (لحفظ صور الامتحانات) ======
async function saveExamImage(data) {
    if (firestoreAvailable && db) {
        try {
            const docRef = await db.collection('examImages').add(data);
            return { id: docRef.id, ...data };
        } catch (error) {
            console.error('Error saving exam image:', error);
            return null;
        }
    }
    data.id = nextId++;
    inMemoryData.examImages.push(data);
    return data;
}

async function getExamImages() {
    if (firestoreAvailable && db) {
        try {
            const snapshot = await db.collection('examImages').orderBy('createdAt', 'desc').get();
            if (!snapshot.empty) {
                return snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
            }
        } catch (error) {
            console.error('Error fetching exam images:', error);
        }
    }
    return inMemoryData.examImages;
}

async function deleteExamImage(id) {
    if (firestoreAvailable && db) {
        try {
            await db.collection('examImages').doc(id).delete();
            return true;
        } catch (error) {
            console.error('Error deleting exam image:', error);
            return false;
        }
    }
    const index = inMemoryData.examImages.findIndex(e => e.id == id);
    if (index !== -1) {
        inMemoryData.examImages.splice(index, 1);
        return true;
    }
    return false;
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

// === Check if student has attempted exam ===
app.get('/api/check-attempt/:groupSlug/:studentName', async (req, res) => {
    try {
        const { groupSlug, studentName } = req.params;
        const hasAttempted = await checkStudentAttempt(groupSlug, studentName);
        res.json({ hasAttempted });
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

// ====== إنشاء امتحان يدوي ======
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
            examType: 'manual',
            createdAt: new Date().toISOString()
        };

        const savedExam = await saveExam(exam);
        if (savedExam) {
            const examQuestions = questions.map((q, idx) => ({
                ...q,
                id: idx + 1,
                examId: savedExam.id,
                questionType: q.questionType || 'multiple_choice'
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

// ====== إنشاء امتحان من الصور (تظهر الصور مع الأسئلة) ======
app.post('/api/exams/image', authenticateToken, upload.array('images', 20), async (req, res) => {
    try {
        const { groupId, groupSlug, questionType, questions, examType } = req.body;
        const files = req.files;

        if (!groupId || !groupSlug) {
            return res.status(400).json({ error: 'Group ID and slug required' });
        }

        let parsedQuestions = [];
        
        if (questions) {
            try {
                parsedQuestions = JSON.parse(questions);
            } catch (e) {
                parsedQuestions = [];
            }
        }

        if (files && files.length > 0) {
            const imageData = files.map(file => ({
                filename: file.originalname,
                mimeType: file.mimetype,
                size: file.size,
                data: file.buffer.toString('base64'),
                createdAt: new Date().toISOString()
            }));

            for (const img of imageData) {
                await saveExamImage({
                    groupId,
                    groupSlug,
                    ...img
                });
            }

            if (parsedQuestions.length === 0) {
                parsedQuestions = imageData.map((img, index) => ({
                    text: `سؤال ${index + 1}`,
                    options: ['الخيار A', 'الخيار B', 'الخيار C', 'الخيار D'],
                    correct: 0,
                    questionType: questionType || 'multiple_choice',
                    imageData: img.data,
                    imageMime: img.mimeType
                }));
            }
        }

        if (parsedQuestions.length === 0) {
            return res.status(400).json({ error: 'No questions or images provided' });
        }

        const exam = {
            groupId,
            groupSlug,
            questionsCount: parsedQuestions.length,
            isPublished: true,
            examType: examType || 'image',
            questionType: questionType || 'multiple_choice',
            createdAt: new Date().toISOString()
        };

        const savedExam = await saveExam(exam);
        if (savedExam) {
            const examQuestions = parsedQuestions.map((q, idx) => ({
                ...q,
                id: idx + 1,
                examId: savedExam.id,
                questionType: q.questionType || questionType || 'multiple_choice'
            }));
            await saveQuestions(examQuestions);
            res.json({ success: true, exam: savedExam, questionsCount: examQuestions.length });
        } else {
            res.status(500).json({ error: 'Failed to save exam' });
        }
    } catch (error) {
        console.error('Error creating image exam:', error);
        res.status(500).json({ error: error.message });
    }
});

// ====== إنشاء امتحان من صور مع OCR (تحويل إلى أسئلة نصية) ======
app.post('/api/exams/ocr', authenticateToken, upload.array('images', 20), async (req, res) => {
    try {
        const { groupId, groupSlug, questionType, questions, examType } = req.body;
        const files = req.files;

        if (!groupId || !groupSlug) {
            return res.status(400).json({ error: 'Group ID and slug required' });
        }

        let parsedQuestions = [];
        if (questions) {
            try {
                parsedQuestions = JSON.parse(questions);
            } catch (e) {
                parsedQuestions = [];
            }
        }

        // إذا كانت هناك صور مرفوعة ولم تكن هناك أسئلة محللة
        if (files && files.length > 0 && parsedQuestions.length === 0) {
            parsedQuestions = files.map((file, index) => ({
                text: `سؤال من الصورة ${index + 1}: ${file.originalname}`,
                options: ['الخيار A', 'الخيار B', 'الخيار C', 'الخيار D'],
                correct: 0,
                questionType: questionType || 'multiple_choice',
                imageData: file.buffer.toString('base64'),
                imageMime: file.mimetype
            }));
        }

        if (parsedQuestions.length === 0) {
            return res.status(400).json({ error: 'No questions or images provided' });
        }

        const exam = {
            groupId,
            groupSlug,
            questionsCount: parsedQuestions.length,
            isPublished: true,
            examType: examType || 'ocr',
            questionType: questionType || 'multiple_choice',
            createdAt: new Date().toISOString()
        };

        const savedExam = await saveExam(exam);
        if (savedExam) {
            const examQuestions = parsedQuestions.map((q, idx) => ({
                ...q,
                id: idx + 1,
                examId: savedExam.id,
                questionType: q.questionType || questionType || 'multiple_choice'
            }));
            await saveQuestions(examQuestions);
            res.json({ success: true, exam: savedExam, questionsCount: examQuestions.length });
        } else {
            res.status(500).json({ error: 'Failed to save exam' });
        }
    } catch (error) {
        console.error('Error creating OCR exam:', error);
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

app.put('/api/exams/:id/group', authenticateToken, async (req, res) => {
    try {
        const { id } = req.params;
        const { groupId, groupSlug } = req.body;
        
        if (!groupId || !groupSlug) {
            return res.status(400).json({ error: 'Group ID and slug required' });
        }
        
        const updated = await updateExamGroup(id, groupId, groupSlug);
        if (updated) {
            res.json({ success: true });
        } else {
            res.status(404).json({ error: 'Exam not found' });
        }
    } catch (error) {
        console.error('Error updating exam group:', error);
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

        await deleteQuestionsByExamId(examId);
        
        const examQuestions = questions.map((q, idx) => ({
            ...q,
            id: idx + 1,
            examId: examId
        }));
        
        const saved = await saveQuestions(examQuestions);
        if (saved) {
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
        const deleted = await deleteSingleQuestion(req.params.id);
        res.json({ success: deleted });
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
        
        // إزالة بيانات الصور من الأسئلة (لتصغير حجم البيانات)
        const questionsForStudent = questions.map(q => {
            const { imageData, ...rest } = q;
            return rest;
        });
        
        res.json({ exam, questions: questionsForStudent });
    } catch (error) {
        console.error('Error in /api/exam/:slug:', error);
        res.status(500).json({ error: error.message });
    }
});

app.post('/api/submit-exam', async (req, res) => {
    try {
        const { groupSlug, studentName, answers, cheatLog } = req.body;
        
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
            const userAnswer = answers[idx] !== undefined && answers[idx] !== null ? answers[idx] : -1;
            
            // معالجة الأسئلة المقالية
            if (q.questionType === 'essay') {
                results.push({
                    questionId: q.id,
                    questionText: q.text,
                    options: q.options || [],
                    userAnswer: userAnswer,
                    correctAnswer: null,
                    isCorrect: null,
                    isEssay: true,
                    needsReview: true,
                    imageData: q.imageData || null,
                    imageMime: q.imageMime || null
                });
            } else {
                const isCorrect = userAnswer === q.correct;
                if (isCorrect) correctCount++;
                results.push({
                    questionId: q.id,
                    questionText: q.text,
                    options: q.options,
                    userAnswer: userAnswer,
                    correctAnswer: q.correct,
                    isCorrect,
                    isEssay: false,
                    imageData: q.imageData || null,
                    imageMime: q.imageMime || null
                });
            }
        });

        const submission = {
            groupSlug,
            groupId: exam.groupId,
            studentName,
            timestamp: new Date().toISOString(),
            total: questions.length,
            correct: correctCount,
            score: Math.round((correctCount / questions.length) * 100),
            results,
            cheatLog: cheatLog || [],
            examType: exam.examType || 'manual',
            needsReview: results.some(r => r.needsReview)
        };

        const saved = await saveSubmission(submission);
        res.json({ success: true, submission: saved });
    } catch (error) {
        console.error('Error in /api/submit-exam:', error);
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

// === Cheat Reports Routes ===
app.post('/api/cheat-report', async (req, res) => {
    try {
        const { studentName, groupSlug, eventType, details, timestamp } = req.body;
        if (!studentName || !groupSlug || !eventType) {
            return res.status(400).json({ error: 'Missing required fields' });
        }
        
        const report = {
            studentName,
            groupSlug,
            eventType,
            details: details || '',
            timestamp: timestamp || new Date().toISOString()
        };
        
        const saved = await saveCheatReport(report);
        res.json({ success: true, report: saved });
    } catch (error) {
        console.error('Error in /api/cheat-report:', error);
        res.status(500).json({ error: error.message });
    }
});

app.get('/api/cheats', authenticateToken, async (req, res) => {
    try {
        const reports = await getCheatReports();
        res.json(reports);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.delete('/api/cheats', authenticateToken, async (req, res) => {
    try {
        await clearCheatReports();
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.delete('/api/cheats/:id', authenticateToken, async (req, res) => {
    try {
        const id = req.params.id;
        if (firestoreAvailable && db) {
            await db.collection('cheats').doc(id).delete();
        } else {
            const index = inMemoryData.cheats.findIndex(c => c.id == id);
            if (index !== -1) {
                inMemoryData.cheats.splice(index, 1);
            } else {
                return res.status(404).json({ success: false, error: 'Cheat report not found' });
            }
        }
        res.json({ success: true });
    } catch (error) {
        console.error('Error deleting cheat report:', error);
        res.status(500).json({ error: error.message });
    }
});

// ====== الحصول على صور الامتحانات ======
app.get('/api/exam-images', authenticateToken, async (req, res) => {
    try {
        const images = await getExamImages();
        res.json(images);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.delete('/api/exam-images/:id', authenticateToken, async (req, res) => {
    try {
        const deleted = await deleteExamImage(req.params.id);
        res.json({ success: deleted });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// ========== FRONTEND ROUTES ==========

// Login page
app.get('/login', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'login.html'));
});

// Dashboard page
app.get('/dashboard', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'dashboard.html'));
});

// Upload exam page (manual)
app.get('/upload-exam', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'upload-exam.html'));
});

// Upload image exam page (صور تظهر كصور)
app.get('/upload-image-exam', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'upload-image-exam.html'));
});

// Upload OCR exam page (تحويل الصور إلى أسئلة)
app.get('/upload-ocr-exam', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'upload-ocr-exam.html'));
});

// Home page - shows 404
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Group page - passes slug to frontend
app.get('/:groupSlug', (req, res) => {
    const slug = req.params.groupSlug;
    
    const reservedPaths = ['login', 'dashboard', 'api', 'favicon.ico', 'robots.txt', 'upload-exam', 'upload-image-exam', 'upload-ocr-exam'];
    if (reservedPaths.includes(slug) || slug.includes('.')) {
        return res.sendFile(path.join(__dirname, 'public', 'index.html'));
    }
    
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ========== START SERVER ==========
app.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
    console.log(`Firebase: ${firestoreAvailable ? 'Connected' : 'Not connected (using in-memory)'}`);
});
