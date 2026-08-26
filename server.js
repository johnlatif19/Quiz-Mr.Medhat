const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const jwt = require('jsonwebtoken');
const admin = require('firebase-admin');
const path = require('path');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const bcrypt = require('bcrypt');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

// ========== VALIDATION & SECURITY CHECKS ==========
if (!process.env.JWT_SECRET || process.env.JWT_SECRET === 'fallback_secret_123456789') {
    console.error('ERROR: JWT_SECRET must be set to a strong secret in environment variables');
    process.exit(1);
}

if (!process.env.ADMIN_PASSWORD_HASH && !process.env.ADMIN_PASSWORD) {
    console.error('ERROR: ADMIN_PASSWORD_HASH or ADMIN_PASSWORD must be set');
    process.exit(1);
}

if (process.env.ADMIN_PASSWORD && !process.env.ADMIN_PASSWORD_HASH) {
    console.warn('⚠️  Using plain text password. Generate a hash for better security.');
    console.warn('💡 Run: node -e "console.log(require(\\"bcrypt\\").hashSync(\\"' + process.env.ADMIN_PASSWORD + '\\", 10))"');
    console.warn('💡 Then add ADMIN_PASSWORD_HASH to your .env file');
}

// ========== MIDDLEWARE ==========
// Security headers
app.use(helmet({
    contentSecurityPolicy: {
        directives: {
            defaultSrc: ["'self'"],
            scriptSrc: ["'self'", "'unsafe-inline'"],
            styleSrc: ["'self'", "'unsafe-inline'"],
            imgSrc: ["'self'", "data:"],
        },
    },
}));

// CORS - محدود بالمصادر المسموحة
const corsOptions = {
    origin: process.env.ALLOWED_ORIGINS ? process.env.ALLOWED_ORIGINS.split(',') : ['http://localhost:3000'],
    optionsSuccessStatus: 200,
    credentials: true
};
app.use(cors(corsOptions));

app.use(bodyParser.json({ limit: '10mb' }));
app.use(bodyParser.urlencoded({ extended: true, limit: '10mb' }));
app.use(express.static('public'));

// ========== RATE LIMITING ==========
const limiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 دقيقة
    max: 100, // حد أقصى 100 طلب لكل IP
    message: { error: 'Too many requests, please try again later.' }
});
app.use('/api/', limiter);

// Rate limiting خاص بتسجيل الدخول
const loginLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 دقيقة
    max: 5, // 5 محاولات فقط
    message: { error: 'Too many login attempts, please try again later.' }
});

// ========== JWT SECRET ==========
const JWT_SECRET = process.env.JWT_SECRET;
const ADMIN_USERNAME = process.env.ADMIN_USERNAME || 'admin';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;
const ADMIN_PASSWORD_HASH = process.env.ADMIN_PASSWORD_HASH;

// ========== FIREBASE INITIALIZATION ==========
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
        console.log('✅ Firebase initialized successfully');
    } else {
        console.warn('⚠️  FIREBASE_CONFIG not found. Using in-memory storage (DEVELOPMENT ONLY)');
    }
} catch (error) {
    console.error('❌ Firebase initialization error:', error.message);
    console.warn('⚠️  Falling back to in-memory storage (DEVELOPMENT ONLY)');
}

// ========== IN-MEMORY FALLBACK ==========
let inMemoryData = {
    groups: [],
    exams: [],
    questions: [],
    submissions: [],
    cheats: []
};
let nextId = 1;

// ========== HELPER FUNCTIONS ==========

// تنقية المدخلات
function sanitizeString(str) {
    if (!str) return '';
    return str.trim().replace(/[<>]/g, ''); // منع XSS
}

function sanitizeSlug(str) {
    if (!str) return '';
    return str.toLowerCase().trim()
        .replace(/\s+/g, '-')
        .replace(/[^a-z0-9-]/g, '');
}

function validateStudentName(name) {
    if (!name || name.length < 2 || name.length > 50) return false;
    if (!/^[\u0600-\u06FFa-zA-Z\s-]+$/.test(name)) return false; // عربي أو إنجليزي فقط
    return true;
}

function sanitizeObject(obj) {
    const sanitized = {};
    for (let key in obj) {
        if (typeof obj[key] === 'string') {
            sanitized[key] = sanitizeString(obj[key]);
        } else if (Array.isArray(obj[key])) {
            sanitized[key] = obj[key].map(item => 
                typeof item === 'string' ? sanitizeString(item) : item
            );
        } else if (obj[key] && typeof obj[key] === 'object') {
            sanitized[key] = sanitizeObject(obj[key]);
        } else {
            sanitized[key] = obj[key];
        }
    }
    return sanitized;
}

// التحقق من الصلاحيات
function isAdmin(req, res, next) {
    if (req.user && req.user.role === 'admin') {
        next();
    } else {
        res.status(403).json({ error: 'Admin access required' });
    }
}

// ========== DATABASE FUNCTIONS ==========

// === GROUPS ===
async function getGroups() {
    if (firestoreAvailable && db) {
        try {
            const snapshot = await db.collection('groups').orderBy('name').get();
            if (!snapshot.empty) {
                return snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
            }
        } catch (error) {
            console.error('Error fetching groups:', error);
            throw new Error('Database error');
        }
    }
    return inMemoryData.groups;
}

async function saveGroup(group) {
    const sanitized = sanitizeObject(group);
    if (firestoreAvailable && db) {
        try {
            const docRef = await db.collection('groups').add(sanitized);
            return { id: docRef.id, ...sanitized };
        } catch (error) {
            console.error('Error saving group:', error);
            throw new Error('Database error');
        }
    }
    if (!sanitized.id) sanitized.id = nextId++;
    inMemoryData.groups.push(sanitized);
    return sanitized;
}

async function deleteGroup(id) {
    if (firestoreAvailable && db) {
        try {
            // حذف الامتحانات المرتبطة أولاً
            const examsSnapshot = await db.collection('exams').where('groupId', '==', id).get();
            const batch = db.batch();
            examsSnapshot.docs.forEach(doc => {
                batch.delete(doc.ref);
            });
            
            // حذف الأسئلة المرتبطة بالامتحانات
            for (const doc of examsSnapshot.docs) {
                const questionsSnapshot = await db.collection('questions').where('examId', '==', doc.id).get();
                questionsSnapshot.docs.forEach(qDoc => {
                    batch.delete(qDoc.ref);
                });
            }
            
            // حذف المجموعة
            batch.delete(db.collection('groups').doc(id));
            await batch.commit();
            return true;
        } catch (error) {
            console.error('Error deleting group:', error);
            throw new Error('Database error');
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
    const cleanSlug = sanitizeSlug(slug);
    if (!cleanSlug) return null;
    
    if (firestoreAvailable && db) {
        try {
            const snapshot = await db.collection('groups').where('slug', '==', cleanSlug).limit(1).get();
            if (!snapshot.empty) {
                const doc = snapshot.docs[0];
                return { id: doc.id, ...doc.data() };
            }
        } catch (error) {
            console.error('Error fetching group by slug:', error);
            throw new Error('Database error');
        }
    }
    return inMemoryData.groups.find(g => g.slug === cleanSlug);
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
            throw new Error('Database error');
        }
    }
    return inMemoryData.groups.find(g => g.id == id);
}

// === EXAMS ===
async function getExams() {
    if (firestoreAvailable && db) {
        try {
            const snapshot = await db.collection('exams').orderBy('createdAt', 'desc').get();
            if (!snapshot.empty) {
                return snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
            }
        } catch (error) {
            console.error('Error fetching exams:', error);
            throw new Error('Database error');
        }
    }
    return inMemoryData.exams;
}

async function saveExam(exam) {
    const sanitized = sanitizeObject(exam);
    if (firestoreAvailable && db) {
        try {
            const docRef = await db.collection('exams').add(sanitized);
            return { id: docRef.id, ...sanitized };
        } catch (error) {
            console.error('Error saving exam:', error);
            throw new Error('Database error');
        }
    }
    if (!sanitized.id) sanitized.id = nextId++;
    inMemoryData.exams.push(sanitized);
    return sanitized;
}

async function deleteExam(id) {
    if (firestoreAvailable && db) {
        try {
            // حذف الأسئلة المرتبطة
            const questionsSnapshot = await db.collection('questions').where('examId', '==', id).get();
            const batch = db.batch();
            questionsSnapshot.docs.forEach(doc => {
                batch.delete(doc.ref);
            });
            batch.delete(db.collection('exams').doc(id));
            await batch.commit();
            return true;
        } catch (error) {
            console.error('Error deleting exam:', error);
            throw new Error('Database error');
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
    const cleanSlug = sanitizeSlug(slug);
    if (!cleanSlug) return null;
    
    if (firestoreAvailable && db) {
        try {
            console.log('Looking for exam with slug:', cleanSlug);
            const snapshot = await db.collection('exams')
                .where('groupSlug', '==', cleanSlug)
                .where('isPublished', '==', true)
                .limit(1)
                .get();
            if (!snapshot.empty) {
                const doc = snapshot.docs[0];
                const exam = { id: doc.id, ...doc.data() };
                console.log('Exam found:', exam.id);
                return exam;
            }
            console.log('No published exam found for slug:', cleanSlug);
        } catch (error) {
            console.error('Error fetching exam by slug:', error);
            throw new Error('Database error');
        }
    }
    return inMemoryData.exams.find(e => e.groupSlug === cleanSlug && e.isPublished);
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
            throw new Error('Database error');
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
            throw new Error('Database error');
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
    const cleanGroupId = sanitizeString(groupId);
    const cleanGroupSlug = sanitizeSlug(groupSlug);
    
    if (firestoreAvailable && db) {
        try {
            await db.collection('exams').doc(id).update({ 
                groupId: cleanGroupId, 
                groupSlug: cleanGroupSlug 
            });
            return true;
        } catch (error) {
            console.error('Error updating exam group:', error);
            throw new Error('Database error');
        }
    }
    const exam = inMemoryData.exams.find(e => e.id == id);
    if (exam) {
        exam.groupId = cleanGroupId;
        exam.groupSlug = cleanGroupSlug;
        return true;
    }
    return false;
}

// === QUESTIONS ===
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
            throw new Error('Database error');
        }
    }
    
    console.log('Using in-memory questions');
    return inMemoryData.questions.filter(q => q.examId == examId);
}

async function saveQuestions(questions) {
    console.log('Saving questions:', questions.length);
    
    if (!questions || questions.length === 0) {
        throw new Error('No questions to save');
    }
    
    // تنقية الأسئلة
    const sanitizedQuestions = questions.map(q => ({
        ...sanitizeObject(q),
        // التأكد من صحة الخيارات
        options: q.options.map(opt => sanitizeString(opt)),
        correct: parseInt(q.correct) || 0
    }));
    
    if (firestoreAvailable && db) {
        try {
            const batch = db.batch();
            const examId = sanitizedQuestions[0]?.examId;
            
            if (examId) {
                const existing = await db.collection('questions')
                    .where('examId', '==', examId)
                    .get();
                existing.docs.forEach(doc => batch.delete(doc.ref));
                console.log('Deleted', existing.size, 'old questions');
            }
            
            sanitizedQuestions.forEach((q, index) => {
                const docRef = db.collection('questions').doc();
                const data = {
                    ...q,
                    id: index + 1,
                    examId: examId
                };
                batch.set(docRef, data);
                console.log('Adding question', index + 1);
            });
            
            await batch.commit();
            console.log('Questions saved successfully');
            return true;
        } catch (error) {
            console.error('Error saving questions:', error);
            throw new Error('Database error');
        }
    }
    
    inMemoryData.questions = inMemoryData.questions.filter(q => q.examId != sanitizedQuestions[0]?.examId);
    sanitizedQuestions.forEach(q => {
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
            throw new Error('Database error');
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
            throw new Error('Database error');
        }
    }
    const index = inMemoryData.questions.findIndex(q => q.id == id);
    if (index !== -1) {
        inMemoryData.questions.splice(index, 1);
        return true;
    }
    return false;
}

// === SUBMISSIONS ===
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
            throw new Error('Database error');
        }
    }
    return inMemoryData.submissions;
}

async function saveSubmission(submission) {
    // تنقية البيانات
    const sanitized = sanitizeObject(submission);
    // تخزين اسم الطالب بحروف صغيرة للتحقق
    sanitized.studentNameLower = sanitized.studentName.toLowerCase();
    
    if (firestoreAvailable && db) {
        try {
            const docRef = await db.collection('submissions').add(sanitized);
            return { id: docRef.id, ...sanitized };
        } catch (error) {
            console.error('Error saving submission:', error);
            throw new Error('Database error');
        }
    }
    if (!sanitized.id) sanitized.id = nextId++;
    inMemoryData.submissions.push(sanitized);
    return sanitized;
}

async function deleteSubmission(id) {
    if (firestoreAvailable && db) {
        try {
            await db.collection('submissions').doc(id).delete();
            return true;
        } catch (error) {
            console.error('Error deleting submission:', error);
            throw new Error('Database error');
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
    const cleanSlug = sanitizeSlug(groupSlug);
    const cleanName = sanitizeString(studentName);
    const cleanNameLower = cleanName.toLowerCase();
    
    if (firestoreAvailable && db) {
        try {
            const snapshot = await db.collection('submissions')
                .where('groupSlug', '==', cleanSlug)
                .where('studentNameLower', '==', cleanNameLower)
                .get();
            return !snapshot.empty;
        } catch (error) {
            console.error('Error checking attempt:', error);
            throw new Error('Database error');
        }
    }
    return inMemoryData.submissions.some(s => 
        s.groupSlug === cleanSlug && 
        s.studentNameLower === cleanNameLower
    );
}

// === CHEAT REPORTS ===
async function saveCheatReport(report) {
    const sanitized = sanitizeObject(report);
    sanitized.timestamp = sanitized.timestamp || new Date().toISOString();
    
    if (firestoreAvailable && db) {
        try {
            const docRef = await db.collection('cheats').add(sanitized);
            return { id: docRef.id, ...sanitized };
        } catch (error) {
            console.error('Error saving cheat report:', error);
            throw new Error('Database error');
        }
    }
    sanitized.id = nextId++;
    inMemoryData.cheats.push(sanitized);
    return sanitized;
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
            throw new Error('Database error');
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
            throw new Error('Database error');
        }
    }
    inMemoryData.cheats = [];
    return true;
}

async function deleteCheatReport(id) {
    if (firestoreAvailable && db) {
        try {
            await db.collection('cheats').doc(id).delete();
            return true;
        } catch (error) {
            console.error('Error deleting cheat report:', error);
            throw new Error('Database error');
        }
    }
    const index = inMemoryData.cheats.findIndex(c => c.id == id);
    if (index !== -1) {
        inMemoryData.cheats.splice(index, 1);
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

// === LOGIN ===
app.post('/api/login', loginLimiter, async (req, res) => {
    try {
        const { username, password } = req.body;
        
        // تنقية المدخلات
        const cleanUsername = sanitizeString(username);
        const cleanPassword = sanitizeString(password);
        
        if (cleanUsername === ADMIN_USERNAME) {
            let isPasswordValid = false;
            
            // التحقق من كلمة المرور
            if (ADMIN_PASSWORD_HASH && ADMIN_PASSWORD_HASH.startsWith('$2')) {
                // استخدام bcrypt
                try {
                    isPasswordValid = await bcrypt.compare(cleanPassword, ADMIN_PASSWORD_HASH);
                } catch (error) {
                    console.error('Bcrypt comparison error:', error);
                    isPasswordValid = false;
                }
            } else if (ADMIN_PASSWORD) {
                // Fallback للمقارنة العادية (للتوافق مع الإصدارات القديمة)
                isPasswordValid = cleanPassword === ADMIN_PASSWORD;
                if (isPasswordValid && !ADMIN_PASSWORD_HASH) {
                    console.warn('⚠️  Using plain text password comparison. Please migrate to bcrypt hash.');
                }
            }
            
            if (isPasswordValid) {
                const token = jwt.sign({ 
                    username: cleanUsername, 
                    role: 'admin' 
                }, JWT_SECRET, { expiresIn: '24h' });
                return res.json({ success: true, token });
            }
        }
        
        // تأخير الرد لمنع هجمات التوقيت
        setTimeout(() => {
            res.status(401).json({ error: 'Invalid credentials' });
        }, 1000);
    } catch (error) {
        console.error('Login error:', error);
        res.status(500).json({ error: 'Server error' });
    }
});

// === GROUPS ===
app.get('/api/groups', authenticateToken, isAdmin, async (req, res) => {
    try {
        const groups = await getGroups();
        res.json(groups);
    } catch (error) {
        res.status(500).json({ error: 'Server error' });
    }
});

app.post('/api/groups', authenticateToken, isAdmin, async (req, res) => {
    try {
        const { name } = req.body;
        const cleanName = sanitizeString(name);
        
        if (!cleanName || cleanName.length < 2) {
            return res.status(400).json({ error: 'Group name must be at least 2 characters' });
        }
        
        const slug = sanitizeSlug(cleanName);
        if (!slug) {
            return res.status(400).json({ error: 'Invalid group name' });
        }
        
        const existing = await getGroupBySlug(slug);
        if (existing) {
            return res.status(400).json({ error: 'Group with this name already exists' });
        }
        
        const group = { 
            name: cleanName, 
            slug, 
            createdAt: new Date().toISOString() 
        };
        const saved = await saveGroup(group);
        res.json(saved);
    } catch (error) {
        res.status(500).json({ error: 'Server error' });
    }
});

app.delete('/api/groups/:id', authenticateToken, isAdmin, async (req, res) => {
    try {
        const deleted = await deleteGroup(req.params.id);
        res.json({ success: deleted });
    } catch (error) {
        res.status(500).json({ error: 'Server error' });
    }
});

// === CHECK GROUP EXISTS ===
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
        res.status(500).json({ error: 'Server error' });
    }
});

// === CHECK STUDENT ATTEMPT ===
app.get('/api/check-attempt/:groupSlug/:studentName', async (req, res) => {
    try {
        const { groupSlug, studentName } = req.params;
        
        // التحقق من صحة اسم الطالب
        if (!validateStudentName(studentName)) {
            return res.status(400).json({ error: 'Invalid student name' });
        }
        
        const hasAttempted = await checkStudentAttempt(groupSlug, studentName);
        res.json({ hasAttempted });
    } catch (error) {
        res.status(500).json({ error: 'Server error' });
    }
});

// === EXAMS ===
app.get('/api/exams', authenticateToken, isAdmin, async (req, res) => {
    try {
        const exams = await getExams();
        const groups = await getGroups();
        const examsWithGroups = exams.map(exam => {
            const group = groups.find(g => g.id === exam.groupId);
            return { ...exam, groupName: group?.name || 'Unknown' };
        });
        res.json(examsWithGroups);
    } catch (error) {
        res.status(500).json({ error: 'Server error' });
    }
});

app.post('/api/exams', authenticateToken, isAdmin, async (req, res) => {
    try {
        const { groupId, groupSlug, questions } = req.body;
        
        if (!groupId || !groupSlug) {
            return res.status(400).json({ error: 'Group ID and slug required' });
        }
        
        if (!questions || questions.length === 0 || questions.length > 100) {
            return res.status(400).json({ error: 'Questions must be between 1 and 100' });
        }
        
        // التحقق من صحة الأسئلة
        for (let q of questions) {
            if (!q.text || q.text.length < 3) {
                return res.status(400).json({ error: 'Each question must have text' });
            }
            if (!q.options || q.options.length !== 4) {
                return res.status(400).json({ error: 'Each question must have exactly 4 options' });
            }
            if (q.correct === undefined || q.correct === null || q.correct < 0 || q.correct > 3) {
                return res.status(400).json({ error: 'Each question must have a correct answer (0-3)' });
            }
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
        res.status(500).json({ error: 'Server error' });
    }
});

app.put('/api/exams/:id/publish', authenticateToken, isAdmin, async (req, res) => {
    try {
        const id = req.params.id;
        const updated = await updateExamPublish(id, true);
        if (updated) {
            res.json({ success: true });
        } else {
            res.status(404).json({ error: 'Exam not found' });
        }
    } catch (error) {
        res.status(500).json({ error: 'Server error' });
    }
});

app.put('/api/exams/:id/group', authenticateToken, isAdmin, async (req, res) => {
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
        res.status(500).json({ error: 'Server error' });
    }
});

app.delete('/api/exams/:id', authenticateToken, isAdmin, async (req, res) => {
    try {
        await deleteQuestionsByExamId(req.params.id);
        await deleteExam(req.params.id);
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ error: 'Server error' });
    }
});

// === EDIT EXAM QUESTIONS ===
app.put('/api/exams/:id/questions', authenticateToken, isAdmin, async (req, res) => {
    try {
        const examId = req.params.id;
        const { questions } = req.body;
        
        if (!questions || questions.length === 0 || questions.length > 100) {
            return res.status(400).json({ error: 'Questions must be between 1 and 100' });
        }
        
        // التحقق من صحة الأسئلة
        for (let q of questions) {
            if (!q.text || q.text.length < 3) {
                return res.status(400).json({ error: 'Each question must have text' });
            }
            if (!q.options || q.options.length !== 4) {
                return res.status(400).json({ error: 'Each question must have exactly 4 options' });
            }
            if (q.correct === undefined || q.correct === null || q.correct < 0 || q.correct > 3) {
                return res.status(400).json({ error: 'Each question must have a correct answer (0-3)' });
            }
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
        res.status(500).json({ error: 'Server error' });
    }
});

// === DELETE SINGLE QUESTION ===
app.delete('/api/questions/:id', authenticateToken, isAdmin, async (req, res) => {
    try {
        const deleted = await deleteSingleQuestion(req.params.id);
        res.json({ success: deleted });
    } catch (error) {
        res.status(500).json({ error: 'Server error' });
    }
});

// === STUDENT EXAM ===
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
        console.log('Exam found:', exam.id);
        
        const questions = await getQuestionsByExamId(exam.id);
        console.log('Questions returned:', questions.length);
        
        res.json({ exam, questions });
    } catch (error) {
        console.error('Error in /api/exam/:slug:', error);
        res.status(500).json({ error: 'Server error' });
    }
});

app.post('/api/submit-exam', async (req, res) => {
    try {
        const { groupSlug, studentName, answers, cheatLog } = req.body;
        
        // التحقق من صحة البيانات
        if (!groupSlug || !studentName || !answers) {
            return res.status(400).json({ error: 'Missing required fields' });
        }
        
        if (!validateStudentName(studentName)) {
            return res.status(400).json({ error: 'Invalid student name' });
        }
        
        if (!Array.isArray(answers) || answers.length === 0) {
            return res.status(400).json({ error: 'Invalid answers format' });
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
        if (questions.length === 0) {
            return res.status(404).json({ error: 'No questions found for this exam' });
        }

        let correctCount = 0;
        const results = [];

        questions.forEach((q, idx) => {
            const userAnswer = answers[idx] !== undefined && answers[idx] !== null ? parseInt(answers[idx]) : -1;
            const isCorrect = userAnswer === q.correct;
            if (isCorrect) correctCount++;
            results.push({
                questionId: q.id,
                questionText: q.text,
                options: q.options,
                userAnswer: userAnswer,
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
            results,
            cheatLog: cheatLog || []
        };

        const saved = await saveSubmission(submission);
        res.json({ success: true, submission: saved });
    } catch (error) {
        console.error('Error in /api/submit-exam:', error);
        res.status(500).json({ error: 'Server error' });
    }
});

// === SUBMISSIONS (ADMIN) ===
app.get('/api/submissions', authenticateToken, isAdmin, async (req, res) => {
    try {
        const submissions = await getSubmissions();
        res.json(submissions);
    } catch (error) {
        res.status(500).json({ error: 'Server error' });
    }
});

app.delete('/api/submissions/:id', authenticateToken, isAdmin, async (req, res) => {
    try {
        const deleted = await deleteSubmission(req.params.id);
        res.json({ success: deleted });
    } catch (error) {
        res.status(500).json({ error: 'Server error' });
    }
});

// === CHEAT REPORTS ===
app.post('/api/cheat-report', async (req, res) => {
    try {
        const { studentName, groupSlug, eventType, details, timestamp } = req.body;
        
        if (!studentName || !groupSlug || !eventType) {
            return res.status(400).json({ error: 'Missing required fields' });
        }
        
        if (!validateStudentName(studentName)) {
            return res.status(400).json({ error: 'Invalid student name' });
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
        res.status(500).json({ error: 'Server error' });
    }
});

app.get('/api/cheats', authenticateToken, isAdmin, async (req, res) => {
    try {
        const reports = await getCheatReports();
        res.json(reports);
    } catch (error) {
        res.status(500).json({ error: 'Server error' });
    }
});

app.delete('/api/cheats', authenticateToken, isAdmin, async (req, res) => {
    try {
        await clearCheatReports();
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ error: 'Server error' });
    }
});

app.delete('/api/cheats/:id', authenticateToken, isAdmin, async (req, res) => {
    try {
        const deleted = await deleteCheatReport(req.params.id);
        if (deleted) {
            res.json({ success: true });
        } else {
            res.status(404).json({ success: false, error: 'Cheat report not found' });
        }
    } catch (error) {
        console.error('Error deleting cheat report:', error);
        res.status(500).json({ error: 'Server error' });
    }
});

// ========== FRONTEND ROUTES ==========
app.get('/login', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'login.html'));
});

app.get('/dashboard', authenticateToken, (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'dashboard.html'));
});

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/:groupSlug', (req, res) => {
    const slug = req.params.groupSlug;
    
    const reservedPaths = ['login', 'dashboard', 'api', 'favicon.ico', 'robots.txt'];
    if (reservedPaths.includes(slug) || slug.includes('.')) {
        return res.sendFile(path.join(__dirname, 'public', 'index.html'));
    }
    
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ========== ERROR HANDLING ==========
// 404 handler
app.use((req, res) => {
    res.status(404).json({ error: 'Not found' });
});

// Global error handler
app.use((err, req, res, next) => {
    console.error('Unhandled error:', err);
    res.status(500).json({ error: 'Internal server error' });
});

// ========== START SERVER ==========
app.listen(PORT, () => {
    console.log(`🚀 Server running on http://localhost:${PORT}`);
    console.log(`🔥 Firebase: ${firestoreAvailable ? 'Connected ✅' : 'Not connected (using in-memory) ⚠️'}`);
    console.log(`🔐 Security: All security measures enabled ✅`);
    console.log(`📝 Admin username: ${ADMIN_USERNAME}`);
    console.log(`🔑 Password: ${ADMIN_PASSWORD_HASH ? 'Using bcrypt hash ✅' : 'Using plain text ⚠️'}`);
});
