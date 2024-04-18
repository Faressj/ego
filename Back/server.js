const express = require("express");
const cors = require("cors");
const pool = require("./db"); // Assurez-vous que le chemin vers db.js est correct
const crypto = require("crypto"); // Importer crypto
const http = require("http");
const { Server } = require("socket.io");
const jwt = require("jsonwebtoken");
const SECRET_KEY = "votre_secret_jwt"; // Utilisez le même secret que celui utilisé pour signer vos JWT
const fs = require("fs");

const app = express();

// Configuration CORS pour autoriser les requêtes de votre frontend
app.use(
  cors({
    origin: "http://localhost:3001", // Remplacez par l'URL de votre frontend React
  })
);
app.use(express.json());

// Create table if dont exist
const createTable = `
CREATE TABLE IF NOT EXISTS users (
  id SERIAL PRIMARY KEY,
  state VARCHAR(255) DEFAULT OFFLINE,
  userid VARCHAR(255) UNIQUE NOT NULL,
  username VARCHAR(50) NOT NULL,
  elo int(11) DEFAULT 1000,
  profile_picture VARCHAR(255) DEFAULT NULL,
  special_elo VARCHAR(255) DEFAULT NULL,
  email VARCHAR(50) UNIQUE NOT NULL,
  password VARCHAR(50) NOT NULL
)`;
const createGames = `
CREATE TABLE IF NOT EXISTS games (
  id SERIAL PRIMARY KEY,
  player1 VARCHAR(255) NOT NULL,
  player2 VARCHAR(255) NOT NULL,
  progress VARCHAR(255) DEFAULT NULL,
  ended BOOLEAN DEFAULT FALSE,
  winner VARCHAR(255) DEFAULT NULL,
  loser VARCHAR(255) DEFAULT NULL,
  timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  gameId VARCHAR(255) DEFAULT NULL
)`;

async function initializeTables() {
  try {
    await pool.query(createTable);
    console.log("Table 'users' vérifiée ou créée avec succès");

    await pool.query(createGames);
    console.log("Table 'games' vérifiée ou créée avec succès");
  } catch (err) {
    console.error("Erreur lors de la création des tables", err);
  }
}

initializeTables();

app.post("/signup", async (req, res) => {
  const { username, email, password } = req.body;

  if (!username || !email || !password) {
    return res.status(400).json({
      success: false,
      message: "Les champs username, email et password sont requis",
    });
  }

  const userId = crypto.createHash("sha256").update(email).digest("hex");

  const query = `INSERT INTO users (userId, username, email, password) VALUES (?, ?, ?, ?)`;

  try {
    await pool.query(query, [userId, username, email, password]);
    res
      .status(201)
      .json({ success: true, message: "Utilisateur créé avec succès" });
  } catch (error) {
    console.error(error);
    res
      .status(500)
      .json({ success: false, message: "Erreur lors de l'inscription" });
  }
});

app.post("/signin", async (req, res) => {
  const { email, password } = req.body;
  const userId = crypto.createHash("sha256").update(email).digest("hex");

  const query = `SELECT * FROM users WHERE userId = ? AND email = ? AND password = ?`;

  try {
    const [results, fields] = await pool.query(query, [
      userId,
      email,
      password,
    ]);
    if (results.length > 0) {
      // Utilisateur trouvé
      const token = jwt.sign({ id: userId }, SECRET_KEY, { expiresIn: "1h" }); // Expiration en 1 heure
      const stateQuery = "SELECT state FROM users WHERE userId = ?";
      const states = await pool.query(stateQuery, [userId]);
      const state = states[0][0].state;
      if (state == "OFFLINE") {
        const updateStateQuery = `UPDATE users SET state = ? WHERE USERID = ?`;
        const updateState = await pool.query(updateStateQuery, [
          "ONLINE",
          userId,
        ]);
      }
      res.json({
        success: true,
        message: "Connexion réussie",
        token,
        username: results[0].username,
      });
    } else {
      res
        .status(401)
        .json({ success: false, message: "Email ou mot de passe incorrect" });
    }
  } catch (error) {
    console.error("Erreur lors de la connexion", error);
    res.status(500).send("Erreur lors de la connexion");
  }
});

app.post("/logout", (req, res) => {
  const { token } = req.body; // Assurez-vous que le token est envoyé dans le corps de la requête de déconnexion
  if (token) {
    jwt.verify(token, SECRET_KEY, async (err, decoded) => {
      const userId = decoded.id;
      try {
        // Lire les tokens existants
        console.log(userId);
        const logoutQuery = "SELECT state FROM users WHERE userId = ?";
        const states = await pool.query(logoutQuery, [userId]);
        const state = states[0][0].state;
        if (state == "ONLINE") {
          const updateStateQuery = `UPDATE users SET state = ? WHERE USERID = ?`;
          const updateState = await pool.query(updateStateQuery, [
            "OFFLINE",
            userId,
          ]);
        }
        // Si le token n'est pas trouvé, renvoyer une réponse réussie car l'utilisateur est déjà considéré comme déconnecté
        return res.status(200).json({
          success: true,
          message: "Token non trouvé ou utilisateur déjà déconnecté",
        });
      } catch (error) {
        console.error("Erreur lors de la déconnexion", error);
        return res.status(500).json({
          success: false,
          message: "Erreur serveur lors de la déconnexion",
        });
      }
    });
  } else {
    return res
      .status(400)
      .json({ success: false, message: "Token est requis" });
  }
});

const PORT = process.env.PORT || 3000;
const server = app.listen(PORT, () => {
  console.log(`Serveur démarré sur le port ${PORT}`);
});

process.on('SIGINT', () => {
  console.log('Closing server...');
  server.close(() => {
      console.log('Server closed.');
      process.exit(0);
  });
});