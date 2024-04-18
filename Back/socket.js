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

const server2 = http.createServer(app);

const io = new Server(server2, {
  cors: {
    origin: "http://localhost:3001", // Remplacez par l'URL de votre frontend React si nécessaire
  },
});

let queue = [];
let userRooms = {};

async function getUserFromDatabase(userId) {
  const query = "SELECT * FROM users WHERE userId = ?";
  try {
    const [results, fields] = await pool.query(query, [userId]);
    if (results.length > 0) {
      return results[0];
    }
    return null;
  } catch (error) {
    console.error("Error querying the database", error);
    return null;
  }
}

io.use((socket, next) => {
  const token = socket.handshake.auth.token;
  if (token) {
    jwt.verify(token, SECRET_KEY, async (err, decoded) => {
      if (err) return next(new Error("Authentication error"));
      const userId = decoded.id;
      try {
        const user = await getUserFromDatabase(userId);
        if (user) {
          socket.username = user.username;
          socket.userId = userId;
          next();
        } else {
          next(new Error("User not found"));
        }
      } catch (error) {
        next(new Error("Database error"));
      }
    });
  } else {
    next(new Error("Authentication error"));
  }
});

function updateUserSocketId(userId, socketId) {
  if (userRooms[userId]) {
    userRooms[userId].socketId = socketId;
  }
}

io.on("connection", (socket) => {
  console.log(`User connected: ${socket.id}`);
  const userRoom = userRooms[socket.userId];
  const userId = socket.userId;
  updateUserSocketId(userId, socket.id);

  socket.on("deleteGame", () => {
    const userId = socket.userId;
    deleteGame(userId);
  });

  async function deleteGame() {
    const gameDetails = await checkPlayerInGame(userId);
    if (gameDetails) {
      const deleteGame = "DELETE FROM games WHERE gameId = ?";
      try {
        await pool.query(deleteGame, [gameDetails.gameId]);
      } catch (error) {
        console.error(
          "Erreur lors de la requête des derniers caractères de progression",
          error
        );
      }
    }
  }

  socket.on("checkExistingMatch", async () => {
    const userId = socket.userId;
    const gameDetails = await checkPlayerInGame(userId);

    if (gameDetails) {
      const room = gameDetails.gameId;
      // console.log(gameDetails);
      // const progressQuery =
      //   "SELECT RIGHT(progress, 2) AS lastTwoChars FROM games WHERE gameId = ?";
      const progressQuery = "SELECT progress FROM games WHERE gameId = ?";

      let lastTwoCharsOfProgress;

      let progressResult;
      try {
        progressResult = await pool.query(progressQuery, [room]);
        if (progressResult.length > 0) {
          lastTwoCharsOfProgress = progressResult[0][0].progress.slice(-2);
        } else {
          console.error(
            "Impossible de trouver les détails de progression pour le jeu :",
            room
          );
        }
      } catch (error) {
        console.error(
          "Erreur lors de la requête des derniers caractères de progression",
          error
        );
      }

      const isPlayer1 = gameDetails.player1 === socket.userId;
      const opponentId = isPlayer1 ? gameDetails.player2 : gameDetails.player1;
      const opponentInfo = await getUserFromDatabase(opponentId);

      if (!opponentInfo) {
        console.error(
          "Informations sur l'opposant non trouvées pour l'ID :",
          opponentId
        );
        return;
      }

      socket.join(room);
      socket.emit("matchFound", {
        stones: isPlayer1 ? "black" : "white",
        gameId: room,
        opponentInfo: { id: opponentId, name: opponentInfo.username },
        yourInfo: { id: userId, name: socket.username },
        alreadyStarted: "yes",
        lastTwoCharsOfProgress,
        progress: progressResult[0][0].progress,
      });
    } else {
      socket.emit("NoExistingMatchFound");
      console.error("Details du match non trouvés pour la salle :");
    }
  });
  async function checkPlayerInGame(userId) {
    const query =
      "SELECT * FROM games WHERE (player1 = ? OR player2 = ?) AND ended = 0 LIMIT 1";
    try {
      const [results] = await pool.query(query, [userId, userId]);
      if (results.length > 0) {
        return results[0];
      }
      return null;
    } catch (error) {
      console.error(
        "Erreur lors de la vérification de l'existence d'un match pour le joueur",
        error
      );
      return null;
    }
  }

  socket.on("joinQueue", async (token) => {
    const isUserInQueue = queue.find(
      (player) => player.userId === socket.userId
    );
    if (!isUserInQueue) {
      console.log(`User joined queue: ${socket.username}`);
      queue.push({ socket, userId: socket.userId, username: socket.username });

      if (queue.length >= 2) {
        const [player1, player2] = queue
          .sort(() => 0.5 - Math.random())
          .slice(0, 2);

        queue = queue.filter(
          (player) =>
            player.userId !== player1.userId && player.userId !== player2.userId
        );

        const room = `${player1.userId}#${player2.userId}`;
        player1.socket.join(room);
        player2.socket.join(room);

        const insertQuery = `INSERT INTO games (gameId,player1, player2) VALUES (?,?, ?)`;
        try {
          const [result] = await pool.query(insertQuery, [
            room,
            player1.userId,
            player2.userId,
          ]);
          userRooms[player1.userId] = {
            room,
            opponentId: player2.userId,
            opponentName: player2.username,
            socketId: player1.socket.id,
            justPassed: false,
          };
          userRooms[player2.userId] = {
            room,
            opponentId: player1.userId,
            opponentName: player1.username,
            socketId: player2.socket.id,
            justPassed: false,
          };

          io.to(userRooms[player1.userId].socketId).emit("matchFound", {
            stones: "black",
            gameId: room,
            yourInfo: { id: player1.socket.id, name: player1.username },
            opponentInfo: { id: player2.socket.id, name: player2.username },
          });

          io.to(userRooms[player2.userId].socketId).emit("matchFound", {
            stones: "white",
            gameId: room,
            yourInfo: { id: player2.socket.id, name: player2.username },
            opponentInfo: { id: player1.socket.id, name: player1.username },
          });
        } catch (error) {
          console.error(
            "Erreur lors de l'insertion du jeu dans la base de données :",
            error
          );
        }
      }
    } else {
      console.log(`User ${socket.username} is already in queue.`);
    }
  });

  socket.on("justPassed", async ({ gameId, position, token }) => {
    jwt.verify(token, SECRET_KEY, async (err, decoded) => {
      if (err) {
        socket.emit("error", "Erreur d'authentification");
        return;
      }
      try {
        const gameQuery = `SELECT * FROM games WHERE gameId = ?`;
        const [game] = await pool.query(gameQuery, [gameId]);
        if (game.length === 0) {
          socket.emit("error", gameId);
          return;
        }
        const justPlayedSocketId = userRooms[userId].socketId;
        const opponentSocketId =
          userRooms[userRooms[userId].opponentId].socketId;

        if (
          userRooms[userId].justPassed == true ||
          userRooms[userRooms[userId].opponentId].justPassed == true
        ) {
          io.to(justPlayedSocketId).emit("gameFinished");
          io.to(opponentSocketId).emit("gameFinished");
        } else {
          userRooms[userId].justPassed = true;
          userRooms[userRooms[userId].opponentId].justPassed = true;
        }
        const updateGameQuery = `UPDATE games SET progress = CONCAT(IFNULL(progress, ''), ?), current_turn = CASE WHEN current_turn = 'player1' THEN 'player2' ELSE 'player1' END WHERE gameId = ?`;
        await pool.query(updateGameQuery, [`${position},`, gameId]);

        io.to(opponentSocketId).emit("myTurn");
        io.to(justPlayedSocketId).emit("notMyTurn");
      } catch (error) {
        console.error("Erreur lors de la mise à jour du jeu", error);
        socket.emit("error", "Erreur serveur lors de la mise à jour du jeu");
      }
    });
  });
  socket.on("awayFromWindow", async ({ token }) => {
    console.log("caca en poudre");
    if (token) {
      jwt.verify(token, SECRET_KEY, async (err, decoded) => {
        const userId = decoded.id;
        try {
          // Lire les tokens existants
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
          return;
        } catch (error) {
          console.error("Erreur lors de la déconnexion", error);
        }
      });
    } else {
      return res
        .status(400)
        .json({ success: false, message: "Token est requis" });
    }
  });
  socket.on("Winner", async ({ gameId, token, winnerstone }) => {
    // jwt.verify(token, SECRET_KEY, async (err, decoded) => {
    // if (err) {
    //   socket.emit("error", err);
    //   return;
    // }
    try {
      const playersidQuery = `SELECT * FROM games WHERE gameId = ?`;
      const playersId = await pool.query(playersidQuery, [gameId]);

      const player1ID = playersId[0][0].player1;
      const player2ID = playersId[0][0].player2;
      const winnerQuery = `UPDATE games SET winner = ?, loser = ?, ended=true WHERE gameId = ?`;
      if (winnerstone == "black") {
        await pool.query(winnerQuery, [player1ID, player2ID, gameId]);
      } else if (winnerstone == "white") {
        await pool.query(winnerQuery, [player2ID, player1ID, gameId]);
      } else if (winnerstone == "draw") {
        await pool.query(winnerQuery, ["draw", "draw", gameId]);
      } else {
        console.log("pas de gagnants bizarre");
      }
    } catch (error) {
      console.error("Erreur lors de la mise à jour du jeu", error);
      socket.emit("error", "Erreur serveur lors de la mise à jour du jeu");
    }
    // });
  });
  socket.on("playMove", async ({ gameId, position, token }) => {
    jwt.verify(token, SECRET_KEY, async (err, decoded) => {
      if (err) {
        socket.emit("error", "Erreur d'authentification");
        return;
      }
      const userId = decoded.id;
      try {
        const gameQuery = `SELECT * FROM games WHERE gameId = ?`;
        const [game] = await pool.query(gameQuery, [gameId]);
        if (game.length === 0) {
          socket.emit("error", gameId);
          return;
        }
        console.log(userRooms[userRooms[userId]]);
        if (
          userRooms[userId].justPassed == true ||
          userRooms[userRooms[userId].opponentId].justPassed == true
        ) {
          userRooms[userId].justPassed = false;
          userRooms[userRooms[userId].opponentId].justPassed = false;
        }

        const newTurn =
          game[0].current_turn === "player1" ? "player2" : "player1";

        const updateGameQuery = `UPDATE games SET progress = CONCAT(IFNULL(progress, ''), ?), current_turn = CASE WHEN current_turn = 'player1' THEN 'player2' ELSE 'player1' END WHERE gameId = ?`;
        await pool.query(updateGameQuery, [`${position},`, gameId]);

        const justPlayedSocketId = userRooms[userId].socketId;

        const opponentSocketId =
          userRooms[userRooms[userId].opponentId].socketId;

        io.to(opponentSocketId).emit("myTurn");
        io.to(justPlayedSocketId).emit("notMyTurn");
        io.to(opponentSocketId).emit("gameUpdated", {
          position: position,
          gameId,
          currentTurn: newTurn,
          player1username: game[0].player1,
          player2username: game[0].player2,
        });
      } catch (error) {
        console.error("Erreur lors de la mise à jour du jeu", error);
        socket.emit("error", "Erreur serveur lors de la mise à jour du jeu");
      }
    });
  });
});

const PORTIO = process.env.PORTIO || 3002;
server2.listen(PORTIO, () => console.log(`Server running on port ${PORTIO}`));
process.on('SIGINT', () => {
  console.log('Closing server 2...');
  server2.close(() => {
      console.log('Server 2 closed.');
      process.exit(0);
  });
});