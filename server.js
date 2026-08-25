const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const admin = require('firebase-admin');
const path = require('path');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(bodyParser.json());
app.use(express.static('public'));

// Firebase Admin SDK
if (process.env.FIREBASE_CONFIG) {
  const firebaseConfig = JSON.parse(process.env.FIREBASE_CONFIG);
  admin.initializeApp({
    credential: admin.credential.cert(firebaseConfig),
    databaseURL: `https://${firebaseConfig.project_id}.firebaseio.com`
  });
} else {
  console.warn('No Firebase config found. Using in-memory storage.');
}

const db = admin.firestore ? admin.firestore() : null;
const JWT_SECRET = process.env.JWT_SECRET || 'fallback_secret';
const ADMIN_USERNAME = process.env.ADMIN_USERNAME || 'admin';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin123';

// In-memory fallback storage
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
let inMemoryAnswers = [];
let questionCounter = 3;

// Helper: Get questions from Firestore or memory
async function getQuestions() {
  if (db) {
    const snapshot = await db.collection('questions').orderBy('id').get();
    if (!snapshot.empty) {
      return snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
    }
  }
  return inMemoryQuestions;
}

async function saveQuestion(question) {
  if (db) {
    const docRef = await db.collection('questions').add(question);
    return { id: docRef.id, ...question };
  } else {
    if (!question.id) {
      question.id = questionCounter++;
    }
    inMemoryQuestions.push(question);
    return question;
  }
}

async function updateQuestion(id, data) {
  if (db) {
    await db.collection('questions').doc(id).update(data);
    return { id, ...data };
  } else {
    const index = inMemoryQuestions.findIndex(q => q.id == id);
    if (index !== -1) {
      inMemoryQuestions[index] = { ...inMemoryQuestions[index], ...data };
      return inMemoryQuestions[index];
    }
    return null;
  }
}

async function deleteQuestion(id) {
  if (db) {
    await db.collection('questions').doc(id).delete();
    return true;
  } else {
    const index = inMemoryQuestions.findIndex(q => q.id == id);
    if (index !== -1) {
      inMemoryQuestions.splice(index, 1);
      return true;
    }
    return false;
  }
}

// Middleware: Verify JWT
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
    return res.status(403).json({ error: 'Invalid token.' });
  }
}

// Routes
app.post('/api/login', (req, res) => {
  const { username, password } = req.body;
  
  if (username === ADMIN_USERNAME && password === ADMIN_PASSWORD) {
    const token = jwt.sign({ username, role: 'admin' }, JWT_SECRET, { expiresIn: '24h' });
    res.json({ success: true, token });
  } else {
    res.status(401).json({ error: 'Invalid credentials' });
  }
});

app.get('/api/questions', async (req, res) => {
  try {
    const questions = await getQuestions();
    res.json(questions);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/questions', authenticateToken, async (req, res) => {
  try {
    const question = req.body;
    const saved = await saveQuestion(question);
    res.json(saved);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.put('/api/questions/:id', authenticateToken, async (req, res) => {
  try {
    const id = req.params.id;
    const data = req.body;
    const updated = await updateQuestion(id, data);
    if (updated) {
      res.json(updated);
    } else {
      res.status(404).json({ error: 'Question not found' });
    }
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.delete('/api/questions/:id', authenticateToken, async (req, res) => {
  try {
    const id = req.params.id;
    const deleted = await deleteQuestion(id);
    if (deleted) {
      res.json({ success: true });
    } else {
      res.status(404).json({ error: 'Question not found' });
    }
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/submit-answers', authenticateToken, async (req, res) => {
  try {
    const { userName, answers } = req.body;
    const questions = await getQuestions();
    let correctCount = 0;
    const result = [];
    
    questions.forEach((q, idx) => {
      const userAnswer = answers[idx] !== undefined ? answers[idx] : null;
      const isCorrect = userAnswer === q.correct;
      if (isCorrect) correctCount++;
      result.push({
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
      results: result
    };
    
    if (db) {
      await db.collection('submissions').add(submission);
    } else {
      inMemoryAnswers.push(submission);
    }
    
    res.json(submission);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/submissions', authenticateToken, async (req, res) => {
  try {
    let submissions = [];
    if (db) {
      const snapshot = await db.collection('submissions').orderBy('timestamp', 'desc').get();
      submissions = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
    } else {
      submissions = inMemoryAnswers;
    }
    res.json(submissions);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Serve static files
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/login', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'login.html'));
});

app.get('/dashboard', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'dashboard.html'));
});

app.listen(PORT, () => {
  console.log(`🚀 Server running on http://localhost:${PORT}`);
});
