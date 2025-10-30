import express from "express";
import fileUpload from "express-fileupload";
import dotenv from "dotenv";
import bcrypt from "bcrypt";
import jwt from "jsonwebtoken";
import cookieParser from "cookie-parser";
import cron from "node-cron";
import cors from "cors";
import { v4 as uuidv4 } from "uuid";
import { initDB, getCollection, imagekit, getCluster } from "./db.js";


dotenv.config();
const app = express();
app.use(cors({ origin: true, credentials: true }));


app.use(fileUpload());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());

// init DB
await initDB();

// ===== Middleware to Protect Routes =====
const authMiddleware = async (req, res, next) => {
  const token = req.cookies.token;
  if (!token) return res.status(401).json({ error: "Not authenticated" });

  try {
    const decoded = jwt.verify(token, process.env.SECRET_KEY);
    req.user = decoded;
    next();
  } catch (err) {
    if (err.name === "TokenExpiredError") {
      return res.status(401).json({ error: "Token expired, please login again" });
    }
    return res.status(401).json({ error: "Invalid token" });
  }
};

const adminMiddleware = async (req, res, next) => {
  try {
    if (!req.user) return res.status(401).json({ error: "Not authenticated" });
    if (req.user.role !== "admin") return res.status(403).json({ error: "Admin access required" });
    next();
  } catch (err) {
    res.status(500).json({ error: "Something went wrong in admin check" });
  }
};

// ====== Auth Routes ======

// Position-wise default stats
function getDefaultStats(position) {
  const base = {
    auraPoints: 0,
    matches: 0,
    goals: 0,
    assists: 0,
    points: 500,
    ratingAvg: 0,
    ratingCount: 0,
    wins: 0,
    losses: 0,
    draws: 0,
    captain: false,
    overalRating: 0,
    redCards: 0,
    yellowCards: 0,
    achievements: [],
    teams: [],
    requests: [],
    inventry: [],
    notifications: [],
    matchHistory: [],
  };

  if (position === "Goalkeeper") {
    return {
      ...base,
      diving: 50,
      handling: 50,
      kicking: 50,
      reflexes: 50,
      positioning: 50,
      speed: 40,
    };
  }

  if (position === "Defender") {
    return {
      ...base,
      pace: 45,
      shooting: 30,
      passing: 50,
      dribbling: 40,
      defence: 65,
      physical: 60,
    };
  }

  if (position === "Midfielder") {
    return {
      ...base,
      pace: 60,
      shooting: 55,
      passing: 65,
      dribbling: 60,
      defence: 55,
      physical: 55,
    };
  }

  if (position === "Forward") {
    return {
      ...base,
      pace: 70,
      shooting: 70,
      passing: 55,
      dribbling: 65,
      defence: 35,
      physical: 55,
    };
  }

  // fallback agar kuch aur bheja gaya ho
  return base;
}

// Signup
app.post("/signup", async (req, res) => {
  try {
    const { name, email, password, age, mobileNumber, location, position, foot } = req.body;

    // ✅ 1. Required fields check
    if (!name || !email || !password || !position || !age || !mobileNumber || !location || !foot) {
      return res.status(400).json({
        success: false,
        error: "All fields are required",
      });
    }

    // ✅ 2. Profile image validation
    if (!req.files || !req.files.file) {
      return res.status(400).json({
        success: false,
        error: "Profile image required",
      });
    }

    const file = req.files.file;
    const allowedTypes = ["image/jpeg", "image/jpg", "image/png", "image/webp"];

    if (!allowedTypes.includes(file.mimetype)) {
      return res.status(400).json({
        success: false,
        error: "Profile image must be JPG, JPEG, PNG, or WEBP",
      });
    }

    if (file.size > 2 * 1024 * 1024) { // 2MB max
      return res.status(400).json({
        success: false,
        error: "Profile image size must be less than 2MB",
      });
    }

    const players = getCollection("players");

    // ✅ 3. Unique Email check
    const existing = await players.get(email).catch(() => null);
    if (existing) {
      return res.status(400).json({
        success: false,
        error: "Email already registered",
      });
    }

    // ✅ 4. Upload profile image to ImageKit (with error handling)
    let uploaded;
    try {
      uploaded = await imagekit.upload({
        file: file.data,
        fileName: `${Date.now()}_${file.name}`,
      });
    } catch (uploadErr) {
      console.error("❌ Image upload failed:", uploadErr);
      return res.status(500).json({
        success: false,
        error: "Image upload failed, please try again later",
      });
    }

    // ✅ 5. Hash password
    const hashedPass = await bcrypt.hash(password, 10);

    // ✅ 6. Position-specific default stats
    const defaults = getDefaultStats(position);

    // ✅ 7. Final player data
    const playerData = {
      name,
      email,
      password: hashedPass,
      age,
      mobileNumber,
      location,
      position,
      foot,
      imageUrl: uploaded.url,
      imageFileId: uploaded.fileId,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      ...defaults,
    };

    // ✅ 8. Insert player (safe handling for timeout/duplicate)
    try {
      await players.insert(email, playerData); // Email = document key
    } catch (dbErr) {
      if (dbErr?.message?.includes("DocumentExists")) {
        console.error("⚠️ Duplicate document error:", dbErr);
        return res.status(400).json({
          success: false,
          error: "Email already registered",
        });
      }

      if (dbErr?.message?.includes("ambiguous")) {
        console.error("⚠️ Couchbase timeout/ambiguous error:", dbErr);
        return res.status(503).json({
          success: false,
          error: "Database timeout, please try again later",
        });
      }

      console.error("❌ DB Insert Error:", dbErr);
      return res.status(500).json({
        success: false,
        error: "Could not create account, please try again later",
      });
    }

    // ✅ 9. Success Response
    res.status(201).json({
      success: true,
      message: "Signup successful",
      player: {
        name,
        email,
        position,
        imageUrl: uploaded.url,
      },
    });

  } catch (err) {
    console.error("❌ Signup Route Error:", err);
    res.status(500).json({
      success: false,
      message: "Server error"
    });
  }
});

// Login
app.post("/login", async (req, res) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({ error: "Email and password are required" });
    }

    const players = getCollection("players");
    const playerDoc = await players.get(email).catch(() => null);

    if (!playerDoc) {
      return res.status(400).json({ error: "Invalid email or password" });
    }

    const player = playerDoc.content;

    const isMatch = await bcrypt.compare(password, player.password);
    if (!isMatch) {
      return res.status(400).json({ error: "Invalid email or password" });
    }

    // JWT token with 1 day expiry
    const token = jwt.sign(
      { email: player.email, role: player.role },
      process.env.SECRET_KEY,
      { expiresIn: "7d" } // 🔹 7 days
    );

    res.cookie("token", token, {
      httpOnly: true,
      sameSite: "None",
      secure: true,
      maxAge: 7 * 24 * 60 * 60 * 1000, // 🔹 7 days in milliseconds
    });

    res.json({ message: "Login successful", token, data: player });
  } catch (err) {
    console.error("❌ Login error:", err);
    res.status(500).json({
      success: false,
      message: "Server error"
    });
  }
});

// Logout
app.post("/logout", (req, res) => {
  res.clearCookie("token", { httpOnly: true, secure: true, sameSite: "None" });
  res.json({ message: "Logged out successfully" });
});

// ====== Profile Routes (Protected) ======

// ✅ Get Profile
app.get("/profile", authMiddleware, async (req, res) => {
  try {
    const players = getCollection("players");
    const player = await players.get(req.user.email);
    res.json({
      success: true,
      message: "Profile fetched successfully",
      data: { ...player.content, password: undefined },
    });
  } catch (err) {
    console.error("❌ Get profile error:", err);
    res.status(500).json({
      success: false,
      message: "Server error"
    });
  }
});

// ✅ Update Profile
app.put("/profile", authMiddleware, async (req, res) => {
  try {
    const players = getCollection("players");
    const player = await players.get(req.user.email);

    const allowedUpdates = ["name", "age", "mobileNumber", "location", "position", "foot"];
    const body = req.body || {};
    let updatedData = { ...player.content };

    allowedUpdates.forEach((field) => {
      if (body[field] !== undefined && body[field] !== "") {
        updatedData[field] = body[field];
      }
    });

    if (req.files && req.files.file) {
      const file = req.files.file;
      const allowedTypes = ["image/jpeg", "image/jpg", "image/png", "image/webp"];
      if (!allowedTypes.includes(file.mimetype)) {
        return res.status(400).json({
          success: false,
          message: "Profile image must be JPG, PNG, or WEBP",
        });
      }
      if (file.size > 2 * 1024 * 1024) {
        return res.status(400).json({
          success: false,
          message: "Profile image size must be < 2MB",
        });
      }
      try {
        if (player.content.imageFileId) {
          await imagekit.deleteFile(player.content.imageFileId);
        }
      } catch { }

      const uploaded = await imagekit.upload({
        file: file.data,
        fileName: file.name || `profile_${Date.now()}.jpg`,
      });

      updatedData.imageUrl = uploaded.url;
      updatedData.imageFileId = uploaded.fileId;
    }

    if (body.password && body.password.trim() !== "") {
      updatedData.password = await bcrypt.hash(body.password, 10);
    }

    await players.upsert(req.user.email, updatedData);

    res.json({
      success: true,
      message: "Profile updated successfully",
      data: { ...updatedData, password: undefined },
    });
  } catch (err) {
    console.error("❌ Update profile error:", err);
    res.status(500).json({
      success: false,
      message: "Server error"
    });
  }
});

// ✅ Delete Profile (cleanup too)
app.delete("/profile", authMiddleware, async (req, res) => {
  try {
    const players = getCollection("players");
    const sellItems = getCollection("sellItems");
    const trainers = getCollection("trainers");
    const teams = getCollection("teams");

    const playerDoc = await players.get(req.user.email).catch(() => null);
    if (!playerDoc) {
      return res.status(404).json({
        success: false,
        message: "Player not found",
      });
    }

    const player = playerDoc.content;

    // 1️⃣ Delete sell items
    const query = `
      SELECT META(s).id, s.* 
      FROM \`${process.env.COUCHBASE_BUCKET}\`.\`${process.env.COUCHBASE_SCOPE}\`.\`sellItems\` s
      WHERE s.playerEmail = $email
    `;
    const result = await getCluster().query(query, {
      parameters: { email: req.user.email },
    });

    for (const row of result.rows) {
      try {
        if (row.imageFileId) await imagekit.deleteFile(row.imageFileId);
      } catch { }
      await sellItems.remove(row.id);
    }

    // 2️⃣ Trainer delete
    const trainer = await trainers.get(req.user.email).catch(() => null);
    if (trainer) await trainers.remove(req.user.email);

    // 3️⃣ Teams cleanup
    if (player.teams && player.teams.length > 0) {
      for (const teamId of player.teams) {
        const teamDoc = await teams.get(teamId).catch(() => null);
        if (teamDoc) {
          const team = teamDoc.content;
          if (team.captain === req.user.email) {
            team.teamPlayers = team.teamPlayers.filter((p) => p !== req.user.email);
            if (team.teamPlayers.length > 0) {
              const newCaptain = team.teamPlayers[0];
              team.captain = newCaptain;

              const newCaptainDoc = await players.get(newCaptain).catch(() => null);
              if (newCaptainDoc) {
                let newCapData = newCaptainDoc.content;
                newCapData.captain = true;
                await players.upsert(newCaptain, newCapData);
                await sendNotification(newCaptain, {
                  title: "New Captain Assigned",
                  message: `You are now the captain of team ${team.name}.`,
                  type: "team-update",
                });
              }
              await teams.upsert(teamId, team);
            } else {
              if (team.logoFileId) {
                try {
                  await imagekit.deleteFile(team.logoFileId);
                } catch { }
              }
              await teams.remove(teamId);
            }
          } else {
            team.teamPlayers = team.teamPlayers.filter((p) => p !== req.user.email);
            await teams.upsert(teamId, team);
            await sendNotification(team.captain, {
              title: "Player Left Team",
              message: `Player ${player.name} left your team ${team.name}.`,
              type: "team-update",
            });
          }
        }
      }
    }

    // 4️⃣ Delete profile image
    if (player.imageFileId) {
      try {
        await imagekit.deleteFile(player.imageFileId);
      } catch { }
    }

    // 5️⃣ Delete profile
    await players.remove(req.user.email);

    res.clearCookie("token");
    res.json({
      success: true,
      message: "Profile and related data deleted successfully",
    });
  } catch (err) {
    console.error("❌ Delete profile error:", err);
    res.status(500).json({
      success: false,
      message: "Server error"
    });
  }
});

// ====== Players Routes (Public) ======

// 1️⃣ Players Search
app.get("/players/search", async (req, res) => {
  try {
    const { q } = req.query;
    if (!q || q.trim() === "") {
      return res.status(400).json({
        success: false,
        message: "Search query is required",
      });
    }

    const bucket = process.env.COUCHBASE_BUCKET;
    const scope = process.env.COUCHBASE_SCOPE;
    const collection = "players";

    const query = `
      SELECT META(p).id AS id, p.*
      FROM \`${bucket}\`.\`${scope}\`.\`${collection}\` p
      WHERE LOWER(p.name) LIKE $search
         OR LOWER(p.email) LIKE $search
         OR LOWER(p.position) LIKE $search
      LIMIT 20;
    `;
    const options = { parameters: { search: `%${q.toLowerCase()}%` } };
    const result = await getCluster().query(query, options);

    res.json({
      success: true,
      message: "Players fetched successfully",
      data: result.rows.map(r => {
        const { password, notifications, ...safe } = r;
        return { id: r.id, ...safe };
      }),
    });
  } catch (err) {
    console.error("❌ Players search error:", err);
    res.status(500).json({
      success: false,
      message: "Server error"
    });
  }
});

// 2️⃣ Get Players with Pagination
app.get("/players", async (req, res) => {
  try {
    const offset = parseInt(req.query.offset) || 0;
    const limit = parseInt(req.query.limit) || 30;

    const query = `
      SELECT p.* 
      FROM \`${process.env.COUCHBASE_BUCKET}\`.\`${process.env.COUCHBASE_SCOPE}\`.\`players\` p
      ORDER BY p.name ASC
      LIMIT ${limit} OFFSET ${offset}
    `;
    const result = await getCluster().query(query);

    const safePlayers = result.rows.map((p) => {
      const { password, notifications, ...rest } = p;
      return rest;
    });

    res.json({
      success: true,
      message: "Players fetched successfully",
      data: {
        players: safePlayers,
        pagination: { offset, limit, count: safePlayers.length },
      },
    });
  } catch (err) {
    console.error("❌ Get players error:", err);
    res.status(500).json({
      success: false,
      message: "Server error",
    });
  }
});

// 3️⃣ Get Single Player by Email
app.get("/players/:email", async (req, res) => {
  try {
    const players = getCollection("players");
    const identifier = req.params.email;

    let playerDoc = await players.get(identifier).catch(() => null);

    if (!playerDoc) {
      const bucket = process.env.COUCHBASE_BUCKET;
      const scope = process.env.COUCHBASE_SCOPE;
      const collection = "players";

      const query = `
        SELECT p.*
        FROM \`${bucket}\`.\`${scope}\`.\`${collection}\` p
        WHERE p.email = $email
        LIMIT 1
      `;
      const result = await getCluster().query(query, { parameters: { email: identifier } });

      if (!result.rows.length) {
        return res.status(404).json({
          success: false,
          message: "Player not found",
        });
      }

      playerDoc = { content: result.rows[0] };
    }

    const { password, notifications, ...safePlayer } = playerDoc.content;

    res.json({
      success: true,
      message: "Player fetched successfully",
      data: safePlayer,
    });
  } catch (err) {
    console.error("❌ Get player error:", err);
    res.status(500).json({
      success: false,
      message: "Server error"
    });
  }
});

// ====== Sell Items Routes ======

// 1️⃣ SellItems Search (Public)
app.get("/sell-items/search", async (req, res) => {
  try {
    const { q } = req.query;

    if (!q || q.trim() === "") {
      return res.status(400).json({
        success: false,
        message: "Search query is required",
      });
    }

    const bucket = process.env.COUCHBASE_BUCKET;
    const scope = process.env.COUCHBASE_SCOPE;
    const collection = "sellItems";

    const query = `
      SELECT META(s).id AS id, s
      FROM \`${bucket}\`.\`${scope}\`.\`${collection}\` s
      WHERE LOWER(s.title) LIKE $search
         OR LOWER(s.playerEmail) LIKE $search
      LIMIT 20;
    `;

    const result = await getCluster().query(query, {
      parameters: { search: `%${q.toLowerCase()}%` },
    });

    res.json({
      success: true,
      message: "Sell items fetched successfully",
      data: result.rows.map(r => ({ id: r.id, ...r.s })),
    });
  } catch (err) {
    console.error("❌ Sell items search error:", err);
    res.status(500).json({
      success: false,
      message: "Server error",
    });
  }
});

// 2️⃣ Create Sell Item (Auth)
app.post("/sell-item", authMiddleware, async (req, res) => {
  try {
    const { title, description, price, points } = req.body;

    // Required fields check
    if (!title || !description || !price || !points) {
      return res.status(400).json({
        success: false,
        message: "Title, description, price, and points are required",
      });
    }

    if (!req.files || !req.files.file) {
      return res.status(400).json({
        success: false,
        message: "Item image is required",
      });
    }

    const players = getCollection("players");
    const sellItems = getCollection("sellItems");

    const player = await players.get(req.user.email).catch(() => null);
    if (!player) {
      return res.status(404).json({
        success: false,
        message: "Player not found",
      });
    }

    const file = req.files.file;
    const allowedTypes = ["image/jpeg", "image/jpg", "image/png", "image/webp"];
    if (!allowedTypes.includes(file.mimetype)) {
      return res.status(400).json({
        success: false,
        message: "Item image must be JPG, JPEG, PNG, or WEBP",
      });
    }

    if (file.size > 2 * 1024 * 1024) {
      return res.status(400).json({
        success: false,
        message: "Item image size must be < 2MB",
      });
    }

    const uploaded = await imagekit.upload({
      file: file.data,
      fileName: file.name || `item_${Date.now()}.jpg`,
    });

    const itemData = {
      id: uuidv4(),
      playerEmail: req.user.email,
      title,
      description,
      price: parseFloat(price),
      points: parseInt(points),
      date: new Date().toISOString(),
      imageUrl: uploaded.url,
      imageFileId: uploaded.fileId,
      contact: player.content.mobileNumber || "",
      name: player.content.name || "",
      sold: 0,
    };

    await sellItems.insert(itemData.id, itemData);

    res.json({
      success: true,
      message: "Item added successfully",
      data: itemData,
    });
  } catch (err) {
    console.error("❌ Create sell item error:", err);
    res.status(500).json({
      success: false,
      message: "Server error"
    });
  }
});

// 3️⃣ Get All Sell Items (Public)
app.get("/sell-items", async (req, res) => {
  try {
    const offset = parseInt(req.query.offset) || 0;
    const limit = parseInt(req.query.limit) || 20;

    const query = `
      SELECT s.* 
      FROM \`${process.env.COUCHBASE_BUCKET}\`.\`${process.env.COUCHBASE_SCOPE}\`.\`sellItems\` s
      LIMIT ${limit} OFFSET ${offset}
    `;
    const result = await getCluster().query(query);

    res.json({
      success: true,
      message: "Sell items fetched successfully",
      data: {
        items: result.rows,
        pagination: { offset, limit, count: result.rows.length },
      },
    });
  } catch (err) {
    console.error("❌ Get sell items error:", err);
    res.status(500).json({
      success: false,
      message: "Server error"
    });
  }
});

// 4️⃣ Get Sell Items of a Player (Public)
app.get("/sell-items/:email", async (req, res) => {
  try {
    const email = req.params.email;

    const query = `
      SELECT s.* 
      FROM \`${process.env.COUCHBASE_BUCKET}\`.\`${process.env.COUCHBASE_SCOPE}\`.\`sellItems\` s
      WHERE s.playerEmail = $email
    `;
    const result = await getCluster().query(query, {
      parameters: { email },
    });

    res.json({
      success: true,
      message: "Player sell items fetched successfully",
      data: result.rows,
    });
  } catch (err) {
    console.error("❌ Get player sell items error:", err);
    res.status(500).json({
      success: false,
      message: "Server error"
    });
  }
});

// 5️⃣ Delete Sell Item (Auth)
app.delete("/sell-items/:id", authMiddleware, async (req, res) => {
  try {
    const itemId = req.params.id;
    const sellItems = getCollection("sellItems");

    const item = await sellItems.get(itemId).catch(() => null);
    if (!item) {
      return res.status(404).json({
        success: false,
        message: "Item not found",
      });
    }

    if (item.content.playerEmail !== req.user.email) {
      return res.status(403).json({
        success: false,
        message: "Not authorized to delete this item",
      });
    }

    if (item.content.imageFileId) {
      try {
        await imagekit.deleteFile(item.content.imageFileId);
      } catch (err) {
        console.warn("⚠️ Image delete failed:", err.message);
      }
    }

    await sellItems.remove(itemId);

    res.json({
      success: true,
      message: "Item deleted successfully",
    });
  } catch (err) {
    console.error("❌ Delete sell item error:", err);
    res.status(500).json({
      success: false,
      message: "Server error"
    });
  }
});

//  Buy Item 
app.post("/buy-item", authMiddleware, async (req, res) => {
  try {
    const { sellerEmail, playerEmail, points, itemName, itemId } = req.body;
    if (!sellerEmail || !playerEmail || points == null) {
      return res.status(400).json({ success: false, message: "Missing required data" });
    }

    // 🔹 Send simple notification to seller
    await sendNotification(sellerEmail, {
      title: "New Order Request",
      message: `${playerEmail} wants to buy a ${itemName} with ${points} points.`,
      playerId: playerEmail,
      points: points,
      itemName: itemName,
      itemId: itemId
    });

    res.json({ success: true, message: "Notification sent to seller." });
  } catch (err) {
    console.error("❌ Buy Item Error:", err);
    res.status(500).json({ success: false, message: "Server error" });
  }
});

// ✅ Item Booking - Deduct/Add Points (Seller is auth user)
app.post("/item-sold", authMiddleware, async (req, res) => {
  try {
    const { playerEmail, points, itemName, itemId } = req.body;

    if (!playerEmail || !itemName || points == null || !itemId) {
      return res.status(400).json({ success: false, message: "Missing required data" });
    }

    const players = getCollection("players");
    const sellItems = getCollection("sellItems");

    // 1️⃣ Fetch seller (authenticated user)
    const sellerDoc = await players.get(req.user.email).catch(() => null);
    if (!sellerDoc) {
      return res.status(404).json({ success: false, message: "Seller not found" });
    }
    const seller = sellerDoc.content;

    // 2️⃣ Fetch player (who is buying)
    const playerDoc = await players.get(playerEmail).catch(() => null);
    if (!playerDoc) {
      return res.status(404).json({ success: false, message: "Player not found" });
    }
    const player = playerDoc.content;

    // Ensure points are numbers
    const pointsToTransfer = Number(points);

    // 3️⃣ Check if player has enough points
    if ((Number(player.points) || 0) < pointsToTransfer) {
      return res.status(400).json({ success: false, message: "Player does not have enough points" });
    }

    // 4️⃣ Deduct points from player
    player.points = (Number(player.points) || 0) - pointsToTransfer;

    // 5️⃣ Add points to seller
    seller.points = (Number(seller.points) || 0) + pointsToTransfer;

    // 6️⃣ Update both users in DB
    await players.upsert(playerEmail, player);
    await players.upsert(req.user.email, seller);

    // 7️⃣ Increment `sold` count for item
    const itemDoc = await sellItems.get(itemId).catch(() => null);
    if (itemDoc) {
      const item = itemDoc.content;
      item.sold = (Number(item.sold) || 0) + 1;
      await sellItems.upsert(itemId, item);
    }

    // 8️⃣ Send notifications
    await sendNotification(playerEmail, {
      title: "Order Request Approved ✅",
      message: `Your order ${itemName} from ${req.user.email} has been booked. ${points} points have been deducted from your account.`,
    });

    await sendNotification(req.user.email, {
      title: "New Order Confirmed 🎯",
      message: `You have successfully sold a ${itemName} to ${playerEmail}. ${points} points have been added to your account.`,
    });

    res.json({ success: true, message: "Item sold! Points transferred and sold count updated." });
  } catch (err) {
    console.error("❌ Selling Item Error:", err);
    res.status(500).json({ success: false, message: "Server error" });
  }
});

// ====== Trainers Routes ======

// 1️⃣ Search Trainers
app.get("/trainers/search", async (req, res) => {
  try {
    const { q } = req.query;
    if (!q || q.trim() === "") {
      return res.status(400).json({ success: false, message: "Search query is required" });
    }

    const bucket = process.env.COUCHBASE_BUCKET;
    const scope = process.env.COUCHBASE_SCOPE;
    const collection = "trainers";

    const query = `
      SELECT META(t).id AS id, t.*
      FROM \`${bucket}\`.\`${scope}\`.\`${collection}\` t
      WHERE LOWER(t.name) LIKE $search
         OR LOWER(t.title) LIKE $search
         OR LOWER(t.description) LIKE $search
      LIMIT 20;
    `;
    const options = { parameters: { search: `%${q.toLowerCase()}%` } };
    const result = await getCluster().query(query, options);

    res.json({ success: true, data: result.rows });
  } catch (err) {
    console.error("❌ Trainers Search Error:", err);
    res.status(500).json({ success: false, message: "Server error" });
  }
});

// 2️⃣ Create Trainer Profile (Auth)
app.post("/trainer", authMiddleware, async (req, res) => {
  try {
    const { title, description, price, points, timeSlot, status } = req.body;
    const trainers = getCollection("trainers");
    const players = getCollection("players");

    const player = await players.get(req.user.email).catch(() => null);
    if (!player) {
      return res.status(404).json({ success: false, message: "Player not found" });
    }

    const existing = await trainers.get(req.user.email).catch(() => null);
    if (existing) {
      return res.status(400).json({ success: false, message: "Trainer profile already exists" });
    }

    const trainerData = {
      playerId: req.user.email,
      name: player.content.name,
      imageUrl: player.content.imageUrl,
      mobileNumber: player.content.mobileNumber,
      location: player.content.location,
      title,
      description,
      price: parseFloat(price),
      points: parseInt(points),
      ratingAvg: 0,
      ratingCount: 0,
      status: status || "active",
      timeSlot,
      createdAt: new Date().toISOString(),
    };

    await trainers.insert(req.user.email, trainerData);

    res.json({ success: true, message: "Trainer profile created successfully", data: trainerData });
  } catch (err) {
    console.error("❌ Create Trainer Error:", err);
    res.status(500).json({ success: false, message: "Server error" });
  }
});

// 3️⃣ Update Trainer Profile (Auth)
app.put("/trainer", authMiddleware, async (req, res) => {
  try {
    const trainers = getCollection("trainers");
    const existing = await trainers.get(req.user.email).catch(() => null);
    if (!existing) {
      return res.status(404).json({ success: false, message: "Trainer profile not found" });
    }

    const updates = req.body || {};
    const updatedData = { ...existing.content };

    const allowed = ["title", "description", "price", "points", "status", "timeSlot"];
    allowed.forEach((f) => {
      if (updates[f] !== undefined && updates[f] !== "") {
        updatedData[f] = updates[f];
      }
    });

    await trainers.upsert(req.user.email, updatedData);

    res.json({ success: true, message: "Trainer updated successfully", data: updatedData });
  } catch (err) {
    console.error("❌ Update Trainer Error:", err);
    res.status(500).json({ success: false, message: "Server error" });
  }
});

// 4️⃣ Delete Trainer Profile (Auth)
app.delete("/trainer", authMiddleware, async (req, res) => {
  try {
    const trainers = getCollection("trainers");
    const trainer = await trainers.get(req.user.email).catch(() => null);
    if (!trainer) {
      return res.status(404).json({ success: false, message: "Trainer profile not found" });
    }

    await trainers.remove(req.user.email);

    res.json({ success: true, message: "Trainer profile deleted successfully" });
  } catch (err) {
    console.error("❌ Delete Trainer Error:", err);
    res.status(500).json({ success: false, message: "Server error" });
  }
});

// 5️⃣ Get All Trainers (Public)
app.get("/trainers", async (req, res) => {
  try {
    const query = `
      SELECT t.* 
      FROM \`${process.env.COUCHBASE_BUCKET}\`.\`${process.env.COUCHBASE_SCOPE}\`.\`trainers\` t
    `;
    const result = await getCluster().query(query);

    res.json({
      success: true,
      message: "Trainers fetched successfully",
      data: result.rows,
    });
  } catch (err) {
    console.error("❌ Get All Trainers Error:", err);
    res.status(500).json({ success: false, message: "Server error" });
  }
});

// 6️⃣ Get Trainer by Email (Public)
app.get("/trainers/:email", async (req, res) => {
  try {
    const trainers = getCollection("trainers");
    const trainer = await trainers.get(req.params.email).catch(() => null);
    if (!trainer) {
      return res.status(404).json({ success: false, message: "Trainer not found" });
    }

    res.json({
      success: true,
      message: "Trainer fetched successfully",
      data: trainer.content
    });
  } catch (err) {
    console.error("❌ Get Trainer by Email Error:", err);
    res.status(500).json({ success: false, message: "Server error" });
  }
});

//  Trainer Booking 
app.post("/book-trainer", authMiddleware, async (req, res) => {
  try {
    const { trainerEmail, playerEmail, points } = req.body;
    if (!trainerEmail || !playerEmail || points == null) {
      return res.status(400).json({ success: false, message: "Missing required data" });
    }

    // 🔹 Send simple notification to trainer
    await sendNotification(trainerEmail, {
      title: "New Training Request",
      message: `${playerEmail} wants to book a session with you. Fee: ${points} points.`,
      playerId: playerEmail,
      points: points,
    });

    res.json({ success: true, message: "Notification sent to trainer." });
  } catch (err) {
    console.error("❌ Book Session Error:", err);
    res.status(500).json({ success: false, message: "Server error" });
  }
});

// ✅ Confirm Booking - Deduct/Add Points (Trainer is auth user)
app.post("/trainer-booked", authMiddleware, async (req, res) => {
  try {
    const { playerEmail, points } = req.body;

    if (!playerEmail || points == null) {
      return res.status(400).json({ success: false, message: "Missing required data" });
    }

    const players = getCollection("players");

    // 1️⃣ Fetch trainer (authenticated user)
    const trainerDoc = await players.get(req.user.email).catch(() => null);
    if (!trainerDoc) {
      return res.status(404).json({ success: false, message: "Trainer not found" });
    }
    const trainer = trainerDoc.content;

    // 2️⃣ Fetch player (who is booking)
    const playerDoc = await players.get(playerEmail).catch(() => null);
    if (!playerDoc) {
      return res.status(404).json({ success: false, message: "Player not found" });
    }
    const player = playerDoc.content;

    // Ensure points are numbers
    const pointsToTransfer = Number(points);

    // Check if player has enough points
    if ((Number(player.points) || 0) < pointsToTransfer) {
      return res.status(400).json({ success: false, message: "Player does not have enough points" });
    }

    // 3️⃣ Deduct points from player
    player.points = (Number(player.points) || 0) - pointsToTransfer;

    // 4️⃣ Add points to trainer
    trainer.points = (Number(trainer.points) || 0) + pointsToTransfer;

    // 5️⃣ Save back to DB
    await players.upsert(playerEmail, player);
    await players.upsert(req.user.email, trainer);

    // 🔹 Send notification to player
    await sendNotification(playerEmail, {
      title: "Training Request Approved ✅",
      message: `Your training session with ${req.user.email} has been approved. ${points} points have been deducted from your account.`,
    });

    // 🔹 Send notification to trainer
    await sendNotification(req.user.email, {
      title: "New Training Confirmed 🎯",
      message: `You have successfully approved a training session with ${playerEmail}. ${points} points have been added to your account.`,
    });

    res.json({ success: true, message: "Booking confirmed! Points transferred." });
  } catch (err) {
    console.error("❌ Trainer Booked Error:", err);
    res.status(500).json({ success: false, message: "Server error" });
  }
});

// ====== Teams Routes ======

// Teams Search
app.get("/teams/search", async (req, res) => {
  try {
    const { q } = req.query;
    if (!q || q.trim() === "") {
      return res.status(400).json({ success: false, message: "Search query is required" });
    }

    const bucket = process.env.COUCHBASE_BUCKET;
    const scope = process.env.COUCHBASE_SCOPE;
    const collection = "teams";

    const query = `
      SELECT META(t).id AS id, t.*
      FROM \`${bucket}\`.\`${scope}\`.\`${collection}\` t
      WHERE LOWER(t.name) LIKE $search
         OR LOWER(t.location) LIKE $search
      LIMIT 20;
    `;
    const options = { parameters: { search: `%${q.toLowerCase()}%` } };
    const result = await getCluster().query(query, options);

    res.json({
      success: true,
      message: "Teams fetched successfully",
      data: result.rows.map(r => ({ id: r.id, ...r })),
    });
  } catch (err) {
    console.error("❌ Team Search Error:", err);
    res.status(500).json({ success: false, message: "Server error" });
  }
});

// 🏆 Create Team (Auth)
app.post("/team", authMiddleware, async (req, res) => {
  try {
    const teams = getCollection("teams");
    const players = getCollection("players");

    const { name, location, foundedYear } = req.body;

    if (!req.files || !req.files.logo) {
      return res.status(400).json({ success: false, message: "Team logo is required" });
    }

    const file = req.files.logo;
    const allowedTypes = ["image/jpeg", "image/jpg", "image/png", "image/webp"];
    if (!allowedTypes.includes(file.mimetype)) {
      return res.status(400).json({ success: false, message: "Team logo must be JPG, PNG, or WEBP" });
    }
    if (file.size > 2 * 1024 * 1024) {
      return res.status(400).json({ success: false, message: "Team logo size must be less than 2MB" });
    }

    const uploaded = await imagekit.upload({
      file: file.data,
      fileName: file.name,
    });

    const captainId = req.user.email;
    const teamId = uuidv4();

    const teamData = {
      id: teamId,
      name,
      location: location || "",
      foundedYear: foundedYear || new Date().getFullYear(),
      captain: captainId,
      logoUrl: uploaded.url,
      logoFileId: uploaded.fileId,
      matchesPlayed: 0,
      wins: 0,
      losses: 0,
      draws: 0,
      ratingAvg: 0,
      ratingCount: 0,
      teamPlayers: [captainId],
      requests: [],
      achievements: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    await teams.insert(teamId, teamData);

    const playerDoc = await players.get(captainId).catch(() => null);
    if (playerDoc) {
      const player = playerDoc.content;
      if (!player.teams) player.teams = [];
      if (!player.teams.includes(teamId)) {
        player.teams.push(teamId);
      }
      player.captain = true;
      await players.upsert(captainId, player);
    }

    res.json({ success: true, message: "Team created successfully", data: teamData });
  } catch (err) {
    console.error("❌ Create Team Error:", err);
    res.status(500).json({ success: false, message: "Server error" });
  }
});

// 📃 Get All Teams (No Pagination)
app.get("/teams", async (req, res) => {
  try {
    const query = `
      SELECT META(t).id AS id, t.*
      FROM \`${process.env.COUCHBASE_BUCKET}\`.\`${process.env.COUCHBASE_SCOPE}\`.\`teams\` t
      ORDER BY t.name ASC
    `;

    const result = await getCluster().query(query);

    res.json({
      success: true,
      message: "Teams fetched successfully",
      data: result.rows, // direct array
    });
  } catch (err) {
    console.error("❌ Get All Teams Error:", err);
    res.status(500).json({ success: false, message: "Server error" });
  }
});

// 🔎 Get Team by ID
app.get("/teams/:id", async (req, res) => {
  try {
    const teams = getCollection("teams");
    const team = await teams.get(req.params.id).catch(() => null);
    if (!team) {
      return res.status(404).json({ success: false, message: "Team not found" });
    }

    res.json({ success: true, message: "Team fetched successfully", data: team.content });
  } catch (err) {
    console.error("❌ Get Team by ID Error:", err);
    res.status(500).json({ success: false, message: "Server error" });
  }
});

// Update Team (Only Captain) with Notifications
app.put("/teams/:id", authMiddleware, async (req, res) => {
  try {
    const teams = getCollection("teams");
    const players = getCollection("players");

    // ✅ check team exist
    const existing = await teams.get(req.params.id).catch(() => null);
    if (!existing) {
      return res.status(404).json({ success: false, message: "Team not found" });
    }

    const team = existing.content;

    // ✅ only captain can update
    if (team.captain !== req.user.email) {
      return res.status(403).json({ success: false, message: "Only captain can update team" });
    }

    const name = req.body?.name?.trim();
    const location = req.body?.location?.trim();
    const newCaptain = req.body?.newCaptain?.trim();
    const removePlayer = req.body?.removePlayer?.trim();

    let updatedData = { ...team };

    if (name) updatedData.name = name;
    if (location) updatedData.location = location;

    // ----- Captain Change -----
    if (newCaptain && newCaptain !== team.captain) {
      if (!team.teamPlayers.includes(newCaptain)) {
        return res.status(400).json({ success: false, message: "New captain must be part of the team" });
      }

      updatedData.captain = newCaptain;

      // ✅ old captain update
      const oldCaptainDoc = await players.get(team.captain).catch(() => null);
      if (oldCaptainDoc) {
        let oldCap = oldCaptainDoc.content;
        oldCap.captain = false;
        await players.upsert(team.captain, oldCap);

        await sendNotification(team.captain, {
          title: "Captain Removed",
          message: `You are no longer the captain of team "${team.name}".`,
        });
      }

      // ✅ new captain update
      const newCaptainDoc = await players.get(newCaptain).catch(() => null);
      if (newCaptainDoc) {
        let newCap = newCaptainDoc.content;
        newCap.captain = true;
        await players.upsert(newCaptain, newCap);

        await sendNotification(newCaptain, {
          title: "New Captain",
          message: `You are now the captain of team "${team.name}".`,
        });
      }
    }

    // ----- Remove Player -----
    if (removePlayer) {
      if (!team.teamPlayers.includes(removePlayer)) {
        return res.status(400).json({ success: false, message: "Player not in team" });
      }
      if (removePlayer === team.captain) {
        return res.status(400).json({ success: false, message: "Captain cannot remove himself" });
      }

      // ✅ 1. Remove player from team list
      updatedData.teamPlayers = team.teamPlayers.filter((p) => p !== removePlayer);

      // ✅ 2. Update player doc (remove team ID)
      const playerDoc = await players.get(removePlayer).catch(() => null);
      if (playerDoc) {
        let playerData = playerDoc.content;

        if (Array.isArray(playerData.teams)) {
          playerData.teams = playerData.teams.filter((tid) => tid !== team.id);
        }

        await players.upsert(removePlayer, playerData);
      }

      // ✅ 3. Send notification
      await sendNotification(removePlayer, {
        title: "Removed from Team",
        message: `You have been removed from team "${team.name}".`,
      });
    }


    // ----- Logo Handle -----
    if (req.files && req.files.logo) {
      const file = req.files.logo;
      const allowedTypes = ["image/jpeg", "image/jpg", "image/png", "image/webp"];

      if (!allowedTypes.includes(file.mimetype)) {
        return res.status(400).json({ success: false, message: "Team logo must be JPG, PNG, or WEBP" });
      }
      if (file.size > 2 * 1024 * 1024) {
        return res.status(400).json({ success: false, message: "Team logo size must be < 2MB" });
      }

      try {
        if (team.logoFileId) await imagekit.deleteFile(team.logoFileId);
      } catch (err) {
        console.warn("⚠️ Old logo delete failed:", err.message);
      }

      const uploadRes = await imagekit.upload({
        file: file.data,
        fileName: file.name,
      });

      updatedData.logoUrl = uploadRes.url;
      updatedData.logoFileId = uploadRes.fileId;
    }

    // ✅ final update
    updatedData.updatedAt = new Date().toISOString();
    await teams.upsert(team.id, updatedData);

    // ✅ notify other team members if info changed
    if ((name && name !== team.name) || (location && location !== team.location)) {
      const otherPlayers = updatedData.teamPlayers.filter((p) => p !== req.user.email);
      if (otherPlayers.length > 0) {
        await sendNotification(otherPlayers, {
          title: "Team Updated",
          message: `Team "${team.name}" has been updated.`,
        });
      }
    }

    res.json({
      success: true,
      message: "Team updated successfully",
      data: updatedData,
    });
  } catch (err) {
    console.error("❌ Update Team Error:", err);
    res.status(500).json({ success: false, message: "Server error" });
  }
});

// ❌ Delete Team (Captain Only)
app.delete("/teams/:id", authMiddleware, async (req, res) => {
  try {
    const teams = getCollection("teams");
    const players = getCollection("players");

    const existing = await teams.get(req.params.id).catch(() => null);
    if (!existing) {
      return res.status(404).json({ success: false, message: "Team not found" });
    }

    const team = existing.content;
    if (team.captain !== req.user.email) {
      return res.status(403).json({ success: false, message: "Only captain can delete team" });
    }

    if (team.logoFileId) {
      try {
        await imagekit.deleteFile(team.logoFileId);
      } catch (err) {
        console.warn("⚠️ Failed to delete logo:", err.message);
      }
    }

    const otherPlayers = team.teamPlayers.filter(p => p !== req.user.email);
    if (otherPlayers.length > 0) {
      await sendNotification(otherPlayers, {
        title: "Team Deleted",
        message: `Team "${team.name}" has been deleted by the captain.`,
      });
    }

    for (const playerId of team.teamPlayers) {
      const playerDoc = await players.get(playerId).catch(() => null);
      if (playerDoc) {
        const player = playerDoc.content;
        if (player.teams) {
          player.teams = player.teams.filter(tid => tid !== req.params.id);
          await players.upsert(playerId, player);
        }
      }
    }

    await teams.remove(req.params.id);

    res.json({
      success: true,
      message: "Team deleted successfully and removed from players",
    });
  } catch (err) {
    console.error("❌ Delete Team Error:", err);
    res.status(500).json({ success: false, message: "Server error" });
  }
});

// ✅ Join Request with Captain Notification
app.post("/teams/:id/request", authMiddleware, async (req, res) => {
  try {
    const teams = getCollection("teams");
    const existing = await teams.get(req.params.id).catch(() => null);
    if (!existing) {
      return res.status(404).json({ success: false, message: "Team not found" });
    }

    const team = existing.content;

    if (team.teamPlayers.includes(req.user.email)) {
      return res.status(400).json({ success: false, message: "You are already in this team" });
    }
    if (team.requests.includes(req.user.email)) {
      return res.status(400).json({ success: false, message: "Request already sent" });
    }

    // ✅ Add join request
    team.requests.push(req.user.email);
    await teams.upsert(team.id, team);

    // ✅ Notify captain
    if (team.captain) {
      await sendNotification(team.captain, {
        title: "Team Join Request",
        message: `${req.user.email} has requested to join your team "${team.name}".`,
        teamId: team.id,
        requester: req.user.email,
      });
    }

    res.json({
      success: true,
      message: "Join request sent successfully",
      data: { teamId: team.id, requester: req.user.email }
    });
  } catch (err) {
    console.error("❌ Join Request Error:", err);
    res.status(500).json({ success: false, message: "Server error" });
  }
});

// ✅ Approve/Reject Request (Captain Only) with Notification
app.put("/teams/:id/requests/:playerId", authMiddleware, async (req, res) => {
  try {
    const teams = getCollection("teams");
    const players = getCollection("players");

    const existing = await teams.get(req.params.id).catch(() => null);
    if (!existing) {
      return res.status(404).json({ success: false, message: "Team not found" });
    }

    const team = existing.content;

    if (team.captain !== req.user.email) {
      return res.status(403).json({ success: false, message: "Only captain can manage requests" });
    }

    const playerId = req.params.playerId;
    const action = req.body.action; // "approve" or "reject"

    if (!team.requests.includes(playerId)) {
      return res.status(400).json({ success: false, message: "No such request found" });
    }

    // ✅ Remove request
    team.requests = team.requests.filter(r => r !== playerId);

    if (action === "approve") {
      if (!team.teamPlayers.includes(playerId)) {
        team.teamPlayers.push(playerId);
      }

      // ✅ Update player
      const playerDoc = await players.get(playerId).catch(() => null);
      if (playerDoc) {
        const player = playerDoc.content;
        if (!player.teams) player.teams = [];
        if (!player.teams.includes(req.params.id)) {
          player.teams.push(req.params.id);
        }
        await players.upsert(playerId, player);

        await sendNotification(playerId, {
          title: "Team Request Approved",
          message: `Your request to join "${team.name}" has been approved.`,
        });
      }
    } else if (action === "reject") {
      await sendNotification(playerId, {
        title: "Team Request Rejected",
        message: `Your request to join "${team.name}" has been rejected.`,
      });
    } else {
      return res.status(400).json({ success: false, message: "Invalid action" });
    }

    await teams.upsert(req.params.id, team);

    res.json({
      success: true,
      message: `Request ${action}d successfully`,
      data: team
    });
  } catch (err) {
    console.error("❌ Approve/Reject Request Error:", err);
    res.status(500).json({ success: false, message: "Server error" });
  }
});

// ✅ Leave Team (Player Only, Captain cannot leave) with Notification
app.delete("/teams/:id/leave", authMiddleware, async (req, res) => {
  try {
    const teams = getCollection("teams");
    const players = getCollection("players");

    const existing = await teams.get(req.params.id).catch(() => null);
    if (!existing) {
      return res.status(404).json({ success: false, message: "Team not found" });
    }

    const team = existing.content;

    if (team.captain === req.user.email) {
      return res.status(400).json({ success: false, message: "Captain cannot leave, only delete team" });
    }

    // ✅ Remove player from team
    team.teamPlayers = team.teamPlayers.filter(p => p !== req.user.email);
    await teams.upsert(req.params.id, team);

    // ✅ Remove team from player
    const playerDoc = await players.get(req.user.email).catch(() => null);
    if (playerDoc) {
      const player = playerDoc.content;
      if (player.teams) {
        player.teams = player.teams.filter(tid => tid !== req.params.id);
        await players.upsert(req.user.email, player);
      }
    }

    // ✅ Notify captain
    await sendNotification(team.captain, {
      title: "Player Left Team",
      message: `${req.user.email} has left your team "${team.name}".`,
    });

    res.json({
      success: true,
      message: "Left team successfully",
      data: { teamId: team.id, leaver: req.user.email }
    });
  } catch (err) {
    console.error("❌ Leave Team Error:", err);
    res.status(500).json({ success: false, message: "Server error" });
  }
});

// ✅ Team Invite Player (Captain Only) with Notification
app.post("/teams/:id/invite/:playerId", authMiddleware, async (req, res) => {
  try {
    const teams = getCollection("teams");
    const players = getCollection("players");

    const existing = await teams.get(req.params.id).catch(() => null);
    if (!existing) {
      return res.status(404).json({ success: false, message: "Team not found" });
    }

    const team = existing.content;

    if (team.captain !== req.user.email) {
      return res.status(403).json({ success: false, message: "Only captain can invite players" });
    }

    const playerId = req.params.playerId;
    const playerDoc = await players.get(playerId).catch(() => null);
    if (!playerDoc) {
      return res.status(404).json({ success: false, message: "Player not found" });
    }

    const player = playerDoc.content;

    if (team.teamPlayers.includes(playerId)) {
      return res.status(400).json({ success: false, message: "Player already in team" });
    }
    if (player.requests?.includes(req.params.id)) {
      return res.status(400).json({ success: false, message: "Invite already sent" });
    }

    if (!player.requests) player.requests = [];
    player.requests.push(req.params.id);
    await players.upsert(playerId, player);

    await sendNotification(playerId, {
      title: "Team Invitation",
      message: `You have been invited to join the team "${team.name}" by ${req.user.email}.`,
      teamId: team.id,
    });

    res.json({
      success: true,
      message: "Invite sent successfully",
      data: { teamId: team.id, invitedPlayer: playerId }
    });
  } catch (err) {
    console.error("❌ Invite Player Error:", err);
    res.status(500).json({ success: false, message: "Server error" });
  }
});

// ✅ Player Accept/Reject Team Invite with Notification
app.put("/profile/requests/:teamId", authMiddleware, async (req, res) => {
  try {
    const players = getCollection("players");
    const teams = getCollection("teams");

    const playerDoc = await players.get(req.user.email).catch(() => null);
    if (!playerDoc) {
      return res.status(404).json({ success: false, message: "Player not found" });
    }

    const player = playerDoc.content;
    const teamId = req.params.teamId;
    const action = req.body.action; // "approve" or "reject"

    if (!player.requests?.includes(teamId)) {
      return res.status(400).json({ success: false, message: "No such request found" });
    }

    // ✅ Remove invite request
    player.requests = player.requests.filter(r => r !== teamId);

    const teamDoc = await teams.get(teamId).catch(() => null);
    if (!teamDoc) {
      return res.status(404).json({ success: false, message: "Team not found" });
    }

    const team = teamDoc.content;

    if (action === "approve") {
      // ✅ Add team to player's list
      if (!player.teams) player.teams = [];
      if (!player.teams.includes(teamId)) {
        player.teams.push(teamId);
      }

      // ✅ Add player to team's list
      if (!team.teamPlayers.includes(req.user.email)) {
        team.teamPlayers.push(req.user.email);
      }

      await teams.upsert(teamId, team);

      // ✅ Notify captain
      await sendNotification(team.captain, {
        title: "Team Invite Accepted",
        message: `${req.user.email} has accepted the invite to join your team "${team.name}".`,
      });
    } else if (action === "reject") {
      // ✅ Notify captain
      await sendNotification(team.captain, {
        title: "Team Invite Rejected",
        message: `${req.user.email} has rejected the invite to join your team "${team.name}".`,
      });
    } else {
      return res.status(400).json({ success: false, message: "Invalid action" });
    }

    await players.upsert(req.user.email, player);

    res.json({
      success: true,
      message: `Invite ${action}d successfully`,
      data: { teamId, action, playerEmail: req.user.email }
    });
  } catch (err) {
    console.error("❌ Accept/Reject Invite Error:", err);
    res.status(500).json({ success: false, message: "Server error" });
  }
});

// ---- Trophies CRUD ----

// 1️⃣ Get All Trophies (Public)
app.get("/trophies", async (req, res) => {
  try {
    const query = `
      SELECT t.* 
      FROM \`${process.env.COUCHBASE_BUCKET}\`.\`${process.env.COUCHBASE_SCOPE}\`.\`trophies\` t
    `;
    const result = await getCluster().query(query);

    res.json({ success: true, data: result.rows });
  } catch (err) {
    console.error("❌ Get All Trophies Error:", err);
    res.status(500).json({ success: false, message: "Server error" });
  }
});

// 2️⃣ Get Trophy by ID
app.get("/trophies/:id", async (req, res) => {
  try {
    const trophies = getCollection("trophies");
    const trophy = await trophies.get(req.params.id).catch(() => null);
    if (!trophy) {
      return res.status(404).json({ success: false, message: "Trophy not found" });
    }

    res.json({ success: true, data: trophy.content });
  } catch (err) {
    console.error("❌ Get Trophy Error:", err);
    res.status(500).json({ success: false, message: "Server error" });
  }
});

// 3️⃣ Create Trophy (Admin Only)
app.post("/trophy", authMiddleware, adminMiddleware, async (req, res) => {
  try {
    let { title, fee, distribution, bonuses } = req.body;

    if (!title || !fee || !distribution || !bonuses) {
      return res.status(400).json({ success: false, message: "Missing required fields" });
    }

    try {
      distribution = JSON.parse(distribution);
      bonuses = JSON.parse(bonuses);
    } catch {
      return res.status(400).json({ success: false, message: "Invalid JSON format in distribution/bonuses" });
    }

    if (!req.files || !req.files.icon) {
      return res.status(400).json({ success: false, message: "Trophy image is required" });
    }

    const file = req.files.icon;
    const allowedTypes = ["image/jpeg", "image/jpg", "image/png", "image/webp"];
    if (!allowedTypes.includes(file.mimetype)) {
      return res.status(400).json({ success: false, message: "Trophy image must be JPG, PNG, or WEBP" });
    }

    if (file.size > 2 * 1024 * 1024) {
      return res.status(400).json({ success: false, message: "Trophy image size must be < 2MB" });
    }

    const uploaded = await imagekit.upload({
      file: file.data,
      fileName: file.name,
    });

    const trophies = getCollection("trophies");
    const id = uuidv4();

    const newTrophy = {
      id,
      title,
      fee: Number(fee),
      distribution,
      bonuses,
      icon: uploaded.url,
      iconFileId: uploaded.fileId,
      createdAt: new Date().toISOString(),
    };

    await trophies.insert(id, newTrophy);

    // notify all players
    const allPlayersQuery = `
      SELECT META(p).id 
      FROM \`${process.env.COUCHBASE_BUCKET}\`.\`${process.env.COUCHBASE_SCOPE}\`.\`players\` p
    `;
    const result = await getCluster().query(allPlayersQuery);
    const allPlayerEmails = result.rows.map(r => r.id);

    await sendNotification(allPlayerEmails, {
      title: "New Trophy Available!",
      message: `A new trophy "${newTrophy.title}" has been created.`,
      trophyId: id,
    });

    res.json({ success: true, message: "Trophy created", data: newTrophy });
  } catch (err) {
    console.error("❌ Create Trophy Error:", err);
    res.status(500).json({ success: false, message: "Server error" });
  }
});

// 4️⃣ Update Trophy (Admin Only)
app.put("/trophies/:id", authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const trophies = getCollection("trophies");
    const existing = await trophies.get(req.params.id).catch(() => null);
    if (!existing) {
      return res.status(404).json({ success: false, message: "Trophy not found" });
    }

    let updated = { ...existing.content };
    const { title, fee, distribution, bonuses } = req.body || {};

    if (distribution) {
      try {
        updated.distribution = JSON.parse(distribution);
      } catch {
        return res.status(400).json({ success: false, message: "Invalid JSON format in distribution" });
      }
    }

    if (bonuses) {
      try {
        updated.bonuses = JSON.parse(bonuses);
      } catch {
        return res.status(400).json({ success: false, message: "Invalid JSON format in bonuses" });
      }
    }

    if (title !== undefined) updated.title = title;
    if (fee !== undefined) updated.fee = Number(fee);

    if (req.files && req.files.icon) {
      const file = req.files.icon;
      const allowedTypes = ["image/jpeg", "image/jpg", "image/png", "image/webp"];
      if (!allowedTypes.includes(file.mimetype)) {
        return res.status(400).json({ success: false, message: "Trophy image must be JPG, PNG, or WEBP" });
      }

      if (file.size > 2 * 1024 * 1024) {
        return res.status(400).json({ success: false, message: "Trophy image size must be < 2MB" });
      }

      if (updated.iconFileId) {
        try {
          await imagekit.deleteFile(updated.iconFileId);
        } catch (err) {
          console.warn("⚠️ Failed to delete old trophy image:", err.message);
        }
      }

      const uploaded = await imagekit.upload({
        file: file.data,
        fileName: file.name,
      });

      updated.icon = uploaded.url;
      updated.iconFileId = uploaded.fileId;
    }

    updated.updatedAt = new Date().toISOString();
    await trophies.upsert(req.params.id, updated);

    res.json({ success: true, message: "Trophy updated", data: updated });
  } catch (err) {
    console.error("❌ Update Trophy Error:", err);
    res.status(500).json({ success: false, message: "Server error" });
  }
});

// 5️⃣ Delete Trophy (Admin Only)
app.delete("/trophies/:id", authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const trophies = getCollection("trophies");
    const existing = await trophies.get(req.params.id).catch(() => null);
    if (!existing) {
      return res.status(404).json({ success: false, message: "Trophy not found" });
    }

    const trophy = existing.content;

    if (trophy.iconFileId) {
      try {
        await imagekit.deleteFile(trophy.iconFileId);
      } catch (err) {
        console.warn("⚠️ Failed to delete trophy image:", err.message);
      }
    }

    await trophies.remove(req.params.id);

    // notify all players
    const allPlayersQuery = `
      SELECT META(p).id 
      FROM \`${process.env.COUCHBASE_BUCKET}\`.\`${process.env.COUCHBASE_SCOPE}\`.\`players\` p
    `;
    const result = await getCluster().query(allPlayersQuery);
    const allPlayerEmails = result.rows.map(r => r.id);

    await sendNotification(allPlayerEmails, {
      title: "Trophy Removed",
      message: `The trophy "${trophy.title}" has been removed by admin.`,
    });

    res.json({ success: true, message: "Trophy deleted" });
  } catch (err) {
    console.error("❌ Delete Trophy Error:", err);
    res.status(500).json({ success: false, message: "Server error" });
  }
});

// ---- Inventories CRUD ----

// 🔍 Search Inventories
app.get("/inventories/search", async (req, res) => {
  try {
    const { q } = req.query;
    if (!q || q.trim() === "") {
      return res.status(400).json({ success: false, error: "Search query is required" });
    }

    const bucket = process.env.COUCHBASE_BUCKET;
    const scope = process.env.COUCHBASE_SCOPE;
    const collection = "inventories";

    const query = `
      SELECT META(i).id AS id, i.*
      FROM \`${bucket}\`.\`${scope}\`.\`${collection}\` i
      WHERE LOWER(i.name) LIKE $search
      LIMIT 20;
    `;
    const options = { parameters: { search: `%${q.toLowerCase()}%` } };
    const result = await getCluster().query(query, options);

    if (!result.rows.length) {
      return res.status(404).json({ success: false, message: "No inventory items found" });
    }

    res.json({ success: true, inventories: result.rows });
  } catch (err) {
    console.error("Inventory Search Error:", err);
    res.status(500).json({ success: false, message: "Server error" });
  }
});

// 📦 Get All Inventories
app.get("/inventories", async (req, res) => {
  try {
    const query = `
      SELECT i.* 
      FROM \`${process.env.COUCHBASE_BUCKET}\`.\`${process.env.COUCHBASE_SCOPE}\`.\`inventories\` i
    `;
    const result = await getCluster().query(query);

    res.json({ success: true, inventories: result.rows });
  } catch (err) {
    console.error("Get Inventories Error:", err);
    res.status(500).json({ success: false, message: "Server error" });
  }
});

// 📦 Get Single Inventory by ID
app.get("/inventories/:id", async (req, res) => {
  try {
    const inventories = getCollection("inventories");
    const inventory = await inventories.get(req.params.id).catch(() => null);

    if (!inventory) {
      return res.status(404).json({ success: false, error: "Inventory not found" });
    }

    res.json({ success: true, inventory: inventory.content });
  } catch (err) {
    console.error("Get Inventory Error:", err);
    res.status(500).json({ success: false, message: "Server error" });
  }
});

// ➕ Create Inventory
app.post("/inventory", authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const { name, price, effect, points } = req.body;

    if (!name || !price) {
      return res.status(400).json({ success: false, error: "Missing required fields (name, price)" });
    }

    const inventories = getCollection("inventories");
    const id = uuidv4();

    const newInventory = {
      id,
      name,
      price: Number(price),
      effect: effect || null,
      points: points ? Number(points) : 0,
      createdAt: new Date().toISOString(),
    };

    await inventories.insert(id, newInventory);

    // 🔔 Notify all players
    const allPlayersQuery = `
      SELECT META(p).id 
      FROM \`${process.env.COUCHBASE_BUCKET}\`.\`${process.env.COUCHBASE_SCOPE}\`.\`players\` p
    `;
    const result = await getCluster().query(allPlayersQuery);
    const allPlayerEmails = result.rows.map(r => r.id);

    await sendNotification(allPlayerEmails, {
      title: "New Inventory Item",
      message: `A new inventory item "${newInventory.name}" is now available!`,
      inventoryId: id,
    });

    res.json({ success: true, message: "Inventory created successfully", inventory: newInventory });
  } catch (err) {
    console.error("Create Inventory Error:", err);
    res.status(500).json({ success: false, message: "Server error" });
  }
});

// ✏️ Update Inventory
app.put("/inventories/:id", authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const inventories = getCollection("inventories");
    const existing = await inventories.get(req.params.id).catch(() => null);

    if (!existing) {
      return res.status(404).json({ success: false, error: "Inventory not found" });
    }

    const { name, price, effect, points } = req.body;

    const updated = {
      ...existing.content,
      ...(name && { name }),
      ...(price && { price: Number(price) }),
      ...(points && { points: Number(points) }),
      ...(effect && { effect }),
      updatedAt: new Date().toISOString(),
    };

    await inventories.upsert(req.params.id, updated);

    res.json({ success: true, message: "Inventory updated successfully", inventory: updated });
  } catch (err) {
    console.error("Update Inventory Error:", err);
    res.status(500).json({ success: false, message: "Server error" });
  }
});

// ❌ Delete Inventory
app.delete("/inventories/:id", authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const inventories = getCollection("inventories");
    const existing = await inventories.get(req.params.id).catch(() => null);

    if (!existing) {
      return res.status(404).json({ success: false, error: "Inventory not found" });
    }

    await inventories.remove(req.params.id);

    // 🔔 Notify all players
    const allPlayersQuery = `
      SELECT META(p).id 
      FROM \`${process.env.COUCHBASE_BUCKET}\`.\`${process.env.COUCHBASE_SCOPE}\`.\`players\` p
    `;
    const result = await getCluster().query(allPlayersQuery);
    const allPlayerEmails = result.rows.map(r => r.id);

    await sendNotification(allPlayerEmails, {
      title: "Inventory Item Removed",
      message: `An inventory item "${existing.content.name}" has been removed.`,
    });

    res.json({ success: true, message: "Inventory deleted successfully" });
  } catch (err) {
    console.error("Delete Inventory Error:", err);
    res.status(500).json({ success: false, message: "Server error" });
  }
});

// ====== Matches Routes ======
const matches = getCollection("matches");
const players = getCollection("players");
const teams = getCollection("teams");
const trophies = getCollection("trophies");

// 📦 Get Matches (with optional status filter)
app.get("/matches", async (req, res) => {
  try {
    const { status } = req.query;

    let query = `
      SELECT m.* 
      FROM \`${process.env.COUCHBASE_BUCKET}\`.\`${process.env.COUCHBASE_SCOPE}\`.\`matches\` m
      WHERE m.status NOT IN ["pending", "cancelled"]
    `;

    const result = await getCluster().query(query);
    let allMatches = result.rows;

    if (status) {
      allMatches = allMatches.filter(m => m.status === status);
    }

    res.json({ success: true, matches: allMatches });
  } catch (err) {
    console.error("Get Matches Error:", err);
    res.status(500).json({ success: false, message: "Server error" });
  }
});

// 📦 Get Match by ID
app.get("/matches/:id", async (req, res) => {
  try {
    const { id } = req.params;

    const query = `
      SELECT m.* 
      FROM \`${process.env.COUCHBASE_BUCKET}\`.\`${process.env.COUCHBASE_SCOPE}\`.\`matches\` m
      WHERE m.id = $1
      LIMIT 1
    `;

    const result = await getCluster().query(query, { parameters: [id] });
    const match = result.rows[0];

    if (!match) {
      return res.status(404).json({ success: false, message: "Match not found" });
    }

    res.json({ success: true, match });
  } catch (err) {
    console.error("Get Match by ID Error:", err);
    res.status(500).json({ success: false, message: "Server error" });
  }
});

// ➕ Create Match (Captain only)
app.post("/match", authMiddleware, async (req, res) => {
  try {
    let { trophyId, opponentTeamId, playersSelected, location, startTime, endTime } = req.body;

    if (typeof playersSelected === "string") {
      try {
        playersSelected = JSON.parse(playersSelected);
      } catch {
        playersSelected = [];
      }
    }
    if (!Array.isArray(playersSelected)) playersSelected = [];

    // ✅ Ensure current user is captain
    const myTeamsQuery = `
      SELECT t.* 
      FROM \`${process.env.COUCHBASE_BUCKET}\`.\`${process.env.COUCHBASE_SCOPE}\`.\`teams\` t
      WHERE t.captain = $email
    `;
    const myTeamsResult = await getCluster().query(myTeamsQuery, { parameters: { email: req.user.email } });

    if (!myTeamsResult.rows.length) {
      return res.status(403).json({ success: false, error: "Only a captain can schedule a match" });
    }
    const myTeam = myTeamsResult.rows[0];

    const matchId = uuidv4();
    const matchData = {
      id: matchId,
      trophyId,
      myTeamId: myTeam.id,
      opponentTeamId,
      myPlayers: playersSelected,
      opponentPlayers: [],
      location,
      startTime,
      endTime,
      status: "pending",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    await matches.insert(matchId, matchData);

    // ✅ Notify opponent captain
    const oppTeamDoc = await teams.get(opponentTeamId);
    const oppTeam = oppTeamDoc.content;

    await sendNotification(oppTeam.captain, {
      title: "Match Invitation",
      message: `Your team (${oppTeam.name}) has been invited to a match by ${myTeam.name}`,
      matchId,
      type: "match_invite"
    });

    res.json({ success: true, message: "Match created and invitation sent", match: matchData });
  } catch (err) {
    console.error("Create Match Error:", err);
    res.status(500).json({ success: false, message: "Server error" });
  }
});

// ✏️ Opponent Captain Response
app.put("/matches/:id/response", authMiddleware, async (req, res) => {
  try {
    let { action, playersSelected } = req.body;

    if (typeof playersSelected === "string") {
      try {
        playersSelected = JSON.parse(playersSelected);
      } catch {
        playersSelected = [];
      }
    }

    const matchDoc = await matches.get(req.params.id).catch(() => null);
    if (!matchDoc) {
      return res.status(404).json({ success: false, error: "Match not found" });
    }

    const match = matchDoc.content;

    // ✅ Check opponent captain
    const oppTeamDoc = await teams.get(match.opponentTeamId);
    const oppTeam = oppTeamDoc.content;

    if (oppTeam.captain !== req.user.email) {
      return res.status(403).json({ success: false, error: "Only opponent captain can respond" });
    }

    // ✅ Remove old invite notification
    const oppCaptainDoc = await players.get(oppTeam.captain);
    const oppCaptain = oppCaptainDoc.content;
    oppCaptain.notifications = (oppCaptain.notifications || []).filter(
      (n) => n.matchId !== match.id || n.type !== "match_invite"
    );
    await players.upsert(oppTeam.captain, oppCaptain);

    if (action === "reject") {
      match.status = "cancelled";

      const myTeamDoc = await teams.get(match.myTeamId);
      const allPlayers = [
        ...(myTeamDoc.content.teamPlayers || []),
        ...(oppTeamDoc.content.teamPlayers || []),
      ];

      await sendNotification(allPlayers, {
        title: "Match Cancelled",
        matchId: match.id,
        message: `Match between ${myTeamDoc.content.name} and ${oppTeamDoc.content.name} has been cancelled.`,
      });

      await matches.upsert(match.id, match);
      return res.json({ success: true, message: "Match rejected and cancelled", match });
    }

    if (action === "accept") {
      match.status = "upcoming";
      match.opponentPlayers = playersSelected || [];

      // ⚡ Deduct entry fee if trophy is linked
      if (match.trophyId) {
        const trophyDoc = await trophies.get(match.trophyId).catch(() => null);
        if (trophyDoc) {
          const { fee } = trophyDoc.content;

          const myPlayers = Array.isArray(match.myPlayers) ? match.myPlayers : [];
          const oppPlayers = Array.isArray(match.opponentPlayers) ? match.opponentPlayers : [];

          const myShare = Math.floor(fee / 2 / (myPlayers.length || 1));
          const oppShare = Math.floor(fee / 2 / (oppPlayers.length || 1));

          for (const pid of myPlayers) {
            const pDoc = await players.get(pid).catch(() => null);
            if (pDoc) {
              const player = pDoc.content;
              player.points = (player.points || 0) - myShare;
              await players.upsert(pid, player);
            }
          }

          for (const pid of oppPlayers) {
            const pDoc = await players.get(pid).catch(() => null);
            if (pDoc) {
              const player = pDoc.content;
              player.points = (player.points || 0) - oppShare;
              await players.upsert(pid, player);
            }
          }
        }
      }

      // ✅ Notify all players
      const myTeamDoc = await teams.get(match.myTeamId);
      const allPlayers = [
        ...(myTeamDoc.content.teamPlayers || []),
        ...(oppTeamDoc.content.teamPlayers || []),
      ];

      await sendNotification(allPlayers, {
        title: "Match Upcoming",
        matchId: match.id,
        message: `Match scheduled between ${myTeamDoc.content.name} and ${oppTeamDoc.content.name} at ${match.location.name.split(",")[0]} on ${new Date(match.startTime).toLocaleString()}.`,
      });

      match.updatedAt = new Date().toISOString();
      await matches.upsert(match.id, match);
      return res.json({ success: true, message: "Match accepted successfully", match });
    }

    res.status(400).json({ success: false, error: "Invalid action" });
  } catch (err) {
    console.error("Match Response Error:", err);
    res.status(500).json({ success: false, message: "Server error" });
  }
});

// ⚡ Skill growth config (variables)
const skillValues = {
  goalkeeper: { reflexes: 0.3, diving: 0.25, handling: 0.2, positioning: 0.2, kicking: 0.15, speed: 0.1 },
  defender: { defence: 0.3, physical: 0.25, passing: 0.2, pace: 0.15, dribbling: 0.1, shooting: 0.05 },
  midfielder: { passing: 0.3, dribbling: 0.25, pace: 0.2, defence: 0.15, shooting: 0.15, physical: 0.1 },
  forward: { shooting: 0.3, pace: 0.25, dribbling: 0.2, passing: 0.15, physical: 0.1, defence: 0.05 },
  goals: 0.5,
  assists: 0.4,
  motmBonus: 1,
  cleanSheet: 0.5,
};

// 4️⃣ Finalize Match (Both captains submit first, then auto finalization)
app.put("/matches/:id/finalize", authMiddleware, async (req, res) => {
  try {



    let { teamStats, teamRate } = req.body;

    // ✅ Handle form-data (string to array)
    if (typeof teamStats === "string") {
      try { teamStats = JSON.parse(teamStats); } catch { teamStats = []; }
    }

    // 🏆 Utilities
    function getMultiplier(value) {
      if (value < 70) return 1.0;
      if (value < 80) return 0.7;
      if (value < 85) return 0.5;
      if (value < 90) return 0.3;
      if (value < 95) return 0.15;
      if (value < 99) return 0.05;
      return 0; // capped
    }

    function improveSkill(player, skill, baseGain) {
      const current = player[skill] || 0;
      const multiplier = getMultiplier(current);
      const newValue = Math.min(99, current + baseGain * multiplier);
      player[skill] = parseFloat(newValue.toFixed(1)); // ✅ round to 1 decimal
    }

    function updateOverall(player) {
      const skills = player.position === "Goalkeeper"
        ? ["diving", "handling", "kicking", "reflexes", "positioning", "speed"].map(s => player[s] || 0)
        : ["pace", "shooting", "passing", "dribbling", "defence", "physical"].map(s => player[s] || 0);
      const avg = skills.reduce((a, b) => a + b, 0) / skills.length;
      player.overalRating = parseFloat(avg.toFixed(1));
    }

    // 🔍 Match find
    const matchDoc = await matches.get(req.params.id).catch(() => null);
    if (!matchDoc) {
      return res.status(404).json({ success: false, message: "Match not found" });
    }
    const match = matchDoc.content;

    if (!["live", "upcoming", "completed"].includes(match.status)) {
      return res.status(400).json({ success: false, message: "Match is not active" });
    }

    // ✅ Teams + captain check
    const myTeamDoc = await teams.get(match.myTeamId);
    const oppTeamDoc = await teams.get(match.opponentTeamId);
    const myTeam = myTeamDoc.content;
    const oppTeam = oppTeamDoc.content;

    let submittingTeam = null;
    if (myTeam.captain === req.user.email) submittingTeam = "myTeamStats";
    if (oppTeam.captain === req.user.email) submittingTeam = "oppTeamStats";
    if (!submittingTeam) {
      return res.status(403).json({ success: false, message: "Only captains can submit stats" });
    }

    // ✅ Save submitted stats
    if (submittingTeam === "myTeamStats") {
      match.myTeamStats = teamStats;
      match.myTeamSubmitted = true;
      if (teamRate && teamRate >= 1 && teamRate <= 5) {
        oppTeam.ratingCount = (oppTeam.ratingCount || 0) + 1;
        oppTeam.ratingAvg = Number(((((oppTeam.ratingAvg || 0) * (oppTeam.ratingCount - 1)) + teamRate) / oppTeam.ratingCount).toFixed(2));
        await teams.upsert(oppTeam.id, oppTeam);
      }
    }
    if (submittingTeam === "oppTeamStats") {
      match.oppTeamStats = teamStats;
      match.oppTeamSubmitted = true;
      if (teamRate && teamRate >= 1 && teamRate <= 5) {
        myTeam.ratingCount = (myTeam.ratingCount || 0) + 1;
        myTeam.ratingAvg = Number(((((myTeam.ratingAvg || 0) * (myTeam.ratingCount - 1)) + teamRate) / myTeam.ratingCount).toFixed(2));
        await teams.upsert(myTeam.id, myTeam);
      }
    }

    match.updatedAt = new Date().toISOString();
    await matches.upsert(match.id, match);

    // ⏳ Wait for other captain
    if (!match.myTeamSubmitted || !match.oppTeamSubmitted) {
      return res.json({
        success: true,
        message: "Stats & rating saved. Waiting for other captain to submit.",
        data: match
      });
    }

    // ✅ Both submitted → finalize
    const trophyDoc = await trophies.get(match.trophyId).catch(() => null);
    if (!trophyDoc) {
      return res.status(400).json({ success: false, message: "Trophy not found" });
    }
    const trophy = trophyDoc.content;

    const myGoals = match.myTeamStats.reduce((s, p) => s + (p.goals || 0), 0);
    const oppGoals = match.oppTeamStats.reduce((s, p) => s + (p.goals || 0), 0);

    let winnerTeam = null, loserTeam = null, draw = false;
    if (myGoals > oppGoals) { winnerTeam = myTeam; loserTeam = oppTeam; }
    else if (oppGoals > myGoals) { winnerTeam = oppTeam; loserTeam = myTeam; }
    else draw = true;

    // ✅ MOTM
    const allStats = [...match.myTeamStats, ...match.oppTeamStats];
    let motm = allStats.reduce((best, p) => {
      if ((p.goals || 0) > (best.goals || 0) || ((p.goals || 0) === (best.goals || 0) && (p.assists || 0) > (best.assists || 0))) return p;
      return best;
    }, { goals: 0, assists: 0 });
    if (motm && motm.playerId) {
      await sendNotification(motm.playerId, {
        title: "Man of the Match",
        matchId: match.id,
        message: `🎉 Congratulations! You are the Man of the Match.`
      });
    }

    // ✅ Distribute points & notify
    const pool = trophy.fee;
    const winShare = draw ? pool / 2 : (pool * trophy.distribution.win) / 100;
    const loseShare = draw ? pool / 2 : (pool * trophy.distribution.lose) / 100;

    async function distributePoints(team, stats, share, isWinner, isDraw) {
      const perPlayer = Math.floor(share / stats.length);
      for (const stat of stats) {
        const pDoc = await players.get(stat.playerId).catch(() => null);
        if (!pDoc) continue;
        const player = pDoc.content;

        // 1️⃣ Update basic stats
        player.matches = (player.matches || 0) + 1;
        player.goals = (player.goals || 0) + (stat.goals || 0);
        player.assists = (player.assists || 0) + (stat.assists || 0);
        player.redCards = (player.redCards || 0) + (stat.redCards || 0);
        player.yellowCards = (player.yellowCards || 0) + (stat.yellowCards || 0);
        if (isWinner) player.wins = (player.wins || 0) + 1;
        else if (isDraw) player.draws = (player.draws || 0) + 1;
        else player.losses = (player.losses || 0) + 1;

        // 2️⃣ Skills & overall
        const pos = player.position.toLowerCase();
        if (skillValues[pos]) {
          for (const [sk, val] of Object.entries(skillValues[pos])) improveSkill(player, sk, val);
        }
        if (stat.goals) improveSkill(player, "shooting", stat.goals * skillValues.goals);
        if (stat.assists) improveSkill(player, "passing", stat.assists * skillValues.assists);
        if (isWinner && player.position === "Defender" && oppGoals === 0) improveSkill(player, "defence", skillValues.cleanSheet);
        if (motm && motm.playerId === stat.playerId) improveSkill(player, "dribbling", skillValues.motmBonus);
        updateOverall(player);

        // ✅ Calculate overallPerformance
        const skills = player.position === "Goalkeeper"
          ? ["diving", "handling", "kicking", "reflexes", "positioning", "speed"]
          : ["pace", "shooting", "passing", "dribbling", "defence", "physical"];
        const skillAvg = skills.map(s => player[s] || 0).reduce((a, b) => a + b, 0) / skills.length;

        let statsScore = 0;
        statsScore += (stat.goals || 0) * 5;
        statsScore += (stat.assists || 0) * 3;
        statsScore += (stat.yellowCards || 0) * -2;
        statsScore += (stat.redCards || 0) * -5;
        if (motm && motm.playerId === stat.playerId) statsScore += 10;

        const opponentRating = stat.opponentTeamRating || 50;

        const overallPerformance = Math.min(100, skillAvg * 0.6 + statsScore * 1 + opponentRating * 0.4);
        player.overallPerformance = overallPerformance;

        // 3️⃣ Update matchHistory (max 10)
        player.matchHistory = player.matchHistory || [];
        player.matchHistory.push({
          date: new Date().toISOString(),
          result: isDraw ? "draw" : (isWinner ? "win" : "lose"),
          overallPerformance
        });
        if (player.matchHistory.length > 10) player.matchHistory.shift();

        // 4️⃣ Points & bonuses
        player.points = (player.points || 0) + perPlayer;
        if (stat.goals > 0) player.points += stat.goals * (trophy.bonuses.goal || 0);
        if (stat.assists > 0) player.points += stat.assists * (trophy.bonuses.assist || 0);
        if (motm && motm.playerId === stat.playerId) player.points += trophy.bonuses.motm || 0;

        // 5️⃣ Achievements
        if (isWinner) player.achievements.push(trophy.id);
        if (motm && motm.playerId === stat.playerId) player.achievements.push("MOTM_" + match.id);

        // 6️⃣ Aura
        if (motm && motm.playerId === stat.playerId) player.auraPoints = Math.min(999, (player.auraPoints || 0) + 100);
        else player.auraPoints = Math.max(0, (player.auraPoints || 0) - 100);

        await players.upsert(stat.playerId, player);

        // 7️⃣ Notifications
        await sendNotification(stat.playerId, {
          title: "Match Results",
          matchId: match.id,
          message: isDraw
            ? `Match ended in a draw (${myGoals}-${oppGoals}).`
            : team.id === winnerTeam.id
              ? `Congratulations! Your team ${team.name} won the match (${myGoals}-${oppGoals}).`
              : `Your team ${team.name} lost the match (${myGoals}-${oppGoals}).`
        });

        await sendNotification(stat.playerId, {
          title: "Rate Opponent Team Players",
          matchId: match.id,
          opponentTeamId: team.id === myTeam.id ? oppTeam.id : myTeam.id,
          message: `Please rate opponent team players of ${team.id === myTeam.id ? oppTeam.name : myTeam.name}.`
        });
      }
    }


    await distributePoints(myTeam, match.myTeamStats, myTeam.id === (winnerTeam?.id || null) ? winShare : loseShare, myTeam.id === (winnerTeam?.id || null), draw);
    await distributePoints(oppTeam, match.oppTeamStats, oppTeam.id === (winnerTeam?.id || null) ? winShare : loseShare, oppTeam.id === (winnerTeam?.id || null), draw);

    // ✅ Update teams
    async function updateTeam(team, isWinner, isLoser, isDraw) {
      team.matchesPlayed += 1;
      if (isWinner) { team.wins += 1; team.achievements.push(trophy.id); }
      if (isLoser) team.losses += 1;
      if (isDraw) team.draws += 1;
      team.updatedAt = new Date().toISOString();
      await teams.upsert(team.id, team);
    }

    await updateTeam(myTeam, winnerTeam?.id === myTeam.id, loserTeam?.id === myTeam.id, draw);
    await updateTeam(oppTeam, winnerTeam?.id === oppTeam.id, loserTeam?.id === oppTeam.id, draw);

    // ✅ Finalize match
    match.status = "final";
    match.result = { myGoals, oppGoals, winner: draw ? "draw" : winnerTeam.id, motm: motm ? motm.playerId : null };
    match.updatedAt = new Date().toISOString();
    await matches.upsert(match.id, match);

    return res.json({
      success: true,
      message: "Match finalized successfully",
      data: match
    });

  } catch (err) {
    console.error("❌ Finalize Match Error:", err);
    return res.status(500).json({ success: false, message: "Server error" });
  }
});

// 🗑️ Delete Match (Admin only)
app.delete("/matches/:id", authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const matches = getCollection("matches");
    const matchId = req.params.id;

    const matchDoc = await matches.get(matchId).catch(() => null);
    if (!matchDoc) {
      return res.status(404).json({ success: false, error: "Match not found" });
    }

    await matches.remove(matchId);

    res.json({
      success: true,
      message: "Match deleted successfully",
      matchId,
    });
  } catch (err) {
    console.error("❌ Delete match error:", err);
    res.status(500).json({ success: false, message: "Server error" });
  }
});

// 🗑️ Remove Player Notification (Self only)
app.delete("/players/:email/notifications/:notifId", authMiddleware, async (req, res) => {
  try {
    const players = getCollection("players");
    const { email, notifId } = req.params;

    const playerDoc = await players.get(email).catch(() => null);
    if (!playerDoc) {
      return res.status(404).json({ success: false, error: "Player not found" });
    }

    const player = playerDoc.content;

    // ✅ Sirf apni notifications delete karne ki permission
    if (player.email !== req.user.email) {
      return res.status(403).json({ success: false, error: "Unauthorized" });
    }

    // ✅ Notification filter karo
    const beforeCount = (player.notifications || []).length;
    player.notifications = (player.notifications || []).filter(
      (n) => n.id !== notifId
    );
    const afterCount = player.notifications.length;

    player.updatedAt = new Date().toISOString();
    await players.upsert(player.email, player); // ⚡ email is the key

    res.json({
      success: true,
      message:
        beforeCount === afterCount
          ? "No notification removed (ID not found)"
          : "Notification removed successfully",
      remainingNotifications: player.notifications,
    });
  } catch (err) {
    console.error("❌ Remove notification error:", err);
    res.status(500).json({ success: false, message: "Server error" });
  }
});

// 📢 Send Notification to All Players (Admin or System)
app.post("/notify/all", authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const { title, message } = req.body;

    if (!title || !message) {
      return res.status(400).json({
        success: false,
        message: "Missing title or message.",
      });
    }

    // ✅ Couchbase cluster & query
    const cluster = getCluster();
    const query = `
      SELECT p.email 
      FROM \`${process.env.COUCHBASE_BUCKET}\`.\`${process.env.COUCHBASE_SCOPE}\`.\`players\` AS p
      WHERE p.email IS NOT NULL
    `;

    const result = await cluster.query(query);
    const playerEmails = result.rows.map(row => row.email);

    if (!playerEmails.length) {
      return res.status(404).json({
        success: false,
        message: "No players found to send notifications.",
      });
    }

    // ✅ Send notification to each player
    for (const email of playerEmails) {
      await sendNotification(email, { title, message });
    }

    res.json({
      success: true,
      message: `✅ Notification sent to ${playerEmails.length} players successfully.`,
    });

  } catch (err) {
    console.error("❌ Send All Notifications Error:", err);
    res.status(500).json({
      success: false,
      message: "Server error while sending notifications to all players.",
    });
  }
});

// Push Player Notification (Self only)
app.post("/notify/:email", authMiddleware, async (req, res) => {
  try {
    const { email } = req.params;
    const { title, message } = req.body;

    if (!title || !message) {
      return res.status(400).json({ success: false, message: "Missing title or message" });
    }

    await sendNotification(email, { title, message });

    res.json({ success: true, message: "Notification sent successfully" });
  } catch (err) {
    console.error("❌ Send Notification Error:", err);
    res.status(500).json({ success: false, message: "Server error" });
  }
});

// 🧹 DELETE all notifications (Self only)
app.delete("/players/:email/notifications", authMiddleware, async (req, res) => {
  try {
    const { email } = req.params;

    // 🚫 Only allow deleting own notifications
    if (req.user.email !== email) {
      return res.status(403).json({
        success: false,
        message: "Unauthorized: You can only clear your own notifications",
      });
    }

    const players = getCollection("players");

    // ✅ Fetch player
    const playerDoc = await players.get(email).catch(() => null);
    if (!playerDoc) {
      return res.status(404).json({ success: false, message: "Player not found" });
    }

    const playerData = playerDoc.content;
    playerData.notifications = [];
    playerData.updatedAt = new Date().toISOString();

    // ✅ Save updated data
    await players.upsert(email, playerData);

    res.json({ success: true, message: "All notifications cleared successfully." });
  } catch (err) {
    console.error("❌ Clear notifications error:", err);
    res.status(500).json({
      success: false,
      message: "Server error while clearing notifications.",
    });
  }
});

// ⭐ Player Rating after Match
app.post("/players/rate", authMiddleware, async (req, res) => {
  try {
    let { ratings } = req.body;

    if (typeof ratings === "string") {
      try {
        ratings = JSON.parse(ratings);
      } catch {
        ratings = [];
      }
    }

    if (!Array.isArray(ratings) || ratings.length === 0) {
      return res.status(400).json({ success: false, error: "Invalid ratings format" });
    }

    const players = getCollection("players");
    const updatedPlayers = [];

    for (const r of ratings) {
      if (typeof r.value !== "number" || r.value < 1 || r.value > 5) {
        continue;
      }

      const doc = await players.get(r.email).catch(() => null);
      if (!doc) continue;

      let updatedData = { ...doc.content };

      updatedData.ratingAvg = updatedData.ratingAvg || 0;
      updatedData.ratingCount = updatedData.ratingCount || 0;

      updatedData.ratingAvg =
        (updatedData.ratingAvg * updatedData.ratingCount + r.value) /
        (updatedData.ratingCount + 1);
      updatedData.ratingCount += 1;
      updatedData.updatedAt = new Date().toISOString();

      await players.upsert(r.email, updatedData);

      const { password, notifications, ...safePlayer } = updatedData;
      updatedPlayers.push(safePlayer);
    }

    if (!updatedPlayers.length) {
      return res.status(404).json({ success: false, error: "No valid players found for rating" });
    }

    res.json({
      success: true,
      message: "Ratings updated successfully",
      updatedPlayers,
    });
  } catch (err) {
    console.error("❌ Player rating error:", err);
    res.status(500).json({ success: false, message: "Server error" });
  }
});

// ✅ Leaderboard Route (Consistent Response)
app.get("/leaderboard", async (req, res) => {
  try {
    // --- PLAYERS ---
    const allPlayersRes = await getCluster().query(`
      SELECT p.* 
      FROM \`${process.env.COUCHBASE_BUCKET}\`.\`${process.env.COUCHBASE_SCOPE}\`.\`players\` p
    `);
    let allPlayers = allPlayersRes.rows || [];

    const topScorers = [...allPlayers]
      .sort((a, b) => (b.goals || 0) - (a.goals || 0))
      .slice(0, 3);

    const maxAssists = Math.max(...allPlayers.map(p => p.assists || 0), 0);
    const topAssist = allPlayers.filter(p => (p.assists || 0) === maxAssists);

    const maxRating = Math.max(...allPlayers.map(p => p.ratingAvg || 0), 0);
    const topRatedPlayer = allPlayers.filter(
      p => (p.ratingAvg || 0) === maxRating && p.ratingCount > 0
    );

    const topByPosition = (pos) => {
      const playersByPos = allPlayers.filter(p => p.position === pos);
      if (playersByPos.length === 0) return [];
      const maxRating = Math.max(...playersByPos.map(p => p.overalRating || 0), 0);
      return playersByPos.filter(p => (p.overalRating || 0) === maxRating);
    };

    const topDefender = topByPosition("Defender");
    const topMidfielder = topByPosition("Midfielder");
    const topForward = topByPosition("Forward");
    const topGoalkeeper = topByPosition("Goalkeeper");

    const playersWithMOTM = allPlayers.map(p => {
      const motmCount = (p.achievements || []).filter(a => a.startsWith("MOTM")).length;
      return { ...p, motmCount };
    });
    const maxMOTM = Math.max(...playersWithMOTM.map(p => p.motmCount || 0), 0);
    const topMOTMPlayers = playersWithMOTM.filter(p => p.motmCount === maxMOTM && maxMOTM > 0);

    // --- TEAMS ---
    const allTeamsRes = await getCluster().query(`
      SELECT t.* 
      FROM \`${process.env.COUCHBASE_BUCKET}\`.\`${process.env.COUCHBASE_SCOPE}\`.\`teams\` t
    `);
    let allTeams = allTeamsRes.rows || [];

    const teamsWithWinRate = allTeams.map(t => {
      const totalMatches = (t.wins || 0) + (t.losses || 0) + (t.draws || 0);
      const winRate = totalMatches > 0 ? (t.wins / totalMatches) * 100 : 0;
      return { ...t, winRate };
    });
    const maxWinRate = Math.max(...teamsWithWinRate.map(t => t.winRate || 0), 0);
    const topTeamByWinRate = teamsWithWinRate.filter(t => (t.winRate || 0) === maxWinRate);

    const maxTeamRating = Math.max(...allTeams.map(t => Number(t.ratingAvg || 0)));
    const topRatedTeam = allTeams.filter(
      t => Number(t.ratingAvg || 0) === maxTeamRating
    );

    // ✅ Final Consistent Response
    res.json({
      success: true,
      message: "Leaderboard fetched successfully",
      data: {
        players: {
          topScorers,
          topAssist,
          topRatedPlayer,
          topDefender,
          topMidfielder,
          topForward,
          topGoalkeeper,
          topMOTMPlayers,
        },
        teams: {
          topTeamByWinRate,
          topRatedTeam,
        },
      },
    });
  } catch (err) {
    console.error("❌ Leaderboard error:", err);
    res.status(500).json({ success: false, message: "Server error" });
  }
});

// ✅ Get platform stats (Players, Teams, Coaches, Matches)
app.get("/stats", async (req, res) => {
  try {
    const cluster = getCluster();

    // Queries
    const playerQuery = `SELECT COUNT(*) AS total FROM \`${process.env.COUCHBASE_BUCKET}\`.\`${process.env.COUCHBASE_SCOPE}\`.\`players\``;
    const teamQuery = `SELECT COUNT(*) AS total FROM \`${process.env.COUCHBASE_BUCKET}\`.\`${process.env.COUCHBASE_SCOPE}\`.\`teams\``;
    const trainerQuery = `SELECT COUNT(*) AS total FROM \`${process.env.COUCHBASE_BUCKET}\`.\`${process.env.COUCHBASE_SCOPE}\`.\`trainers\``;
    const matchQuery = `SELECT COUNT(*) AS total FROM \`${process.env.COUCHBASE_BUCKET}\`.\`${process.env.COUCHBASE_SCOPE}\`.\`matches\``;

    // Parallel execution for speed
    const [players, teams, trainers, matches] = await Promise.all([
      cluster.query(playerQuery),
      cluster.query(teamQuery),
      cluster.query(trainerQuery),
      cluster.query(matchQuery),
    ]);

    res.json({
      success: true,
      message: "Stats fetched successfully",
      data: {
        players: players.rows[0]?.total || 0,
        teams: teams.rows[0]?.total || 0,
        trainers: trainers.rows[0]?.total || 0,
        matches: matches.rows[0]?.total || 0,
      },
    });
  } catch (err) {
    console.error("❌ Stats fetch error:", err);
    res.status(500).json({
      success: false,
      message: "Server error while fetching stats",
    });
  }
});
 
// 🔔 Notification Helper Function (Hybrid)
async function sendNotification(recipients, notif) {
  if (!Array.isArray(recipients)) recipients = [recipients];

  await Promise.all(
    recipients.map(async (email) => {
      const playerDoc = await players.get(email).catch(() => null);
      if (!playerDoc) return;

      const player = playerDoc.content;
      player.notifications = player.notifications || [];
      player.notifications.push({
        id: uuidv4(),
        ...notif,
        date: new Date().toISOString(),
      });

      await players.upsert(email, player);
    })
  );
}

// Cron job: har 24 ghantay (remove old notifications)
cron.schedule("0 0 * * *", async () => {
  try {
    console.log("🔄 Notification cleanup job running...");

    const cluster = getCluster();
    const bucket = cluster.bucket(process.env.COUCHBASE_BUCKET);
    const scope = bucket.scope(process.env.COUCHBASE_SCOPE);
    const collection = scope.collection("players");

    // ✅ Saare players fetch karo jinhon ke paas notifications hain
    const query = `
      SELECT META(p).id, p.notifications
      FROM \`${process.env.COUCHBASE_BUCKET}\`.\`${process.env.COUCHBASE_SCOPE}\`.\`players\` p
      WHERE ARRAY_LENGTH(p.notifications) > 0
    `;
    const result = await cluster.query(query);
    const now = new Date();

    for (const row of result.rows) {
      try {
        const playerId = row.id;
        const notifications = row.notifications || [];

        // Sirf wo notifications rakho jo ek hafte se purani na hon
        const updatedNotifications = notifications.filter((n) => {
          const notifTime = new Date(n.date);
          const diffDays = (now - notifTime) / (1000 * 60 * 60 * 24); // convert to days
          return diffDays < 7; // ✅ Sirf 7 din se new notifications rakhni
        });

        if (updatedNotifications.length !== notifications.length) {
          const playerDoc = await collection.get(playerId);
          const playerData = playerDoc.content;

          playerData.notifications = updatedNotifications;

          await collection.replace(playerId, playerData);

          console.log(
            `🗑️ Old notifications removed for player: ${playerId} (${notifications.length - updatedNotifications.length} deleted)`
          );
        }
      } catch (playerErr) {
        console.error(`⚠️ Failed to clean notifications for player ${row.id}:`, playerErr);
      }
    }

    console.log("✅ Notification cleanup job finished.");
  } catch (err) {
    console.error("❌ Notification cleanup job error:", err);
  }
});

// 🕒 Cron job: every 1 minute -> update match status automatically
cron.schedule("* * * * *", async () => {
  try {
    console.log("🔄 Match status updater running...");

    const matches = getCollection("matches");
    const teams = getCollection("teams");

    const now = new Date();

    // ✅ Fetch all matches with status 'upcoming' or 'live'
    const query = `
      SELECT m.*
      FROM \`${process.env.COUCHBASE_BUCKET}\`.\`${process.env.COUCHBASE_SCOPE}\`.\`matches\` m
      WHERE m.status IN ["upcoming", "live"]
    `;

    const result = await getCluster().query(query);
    const rows = result.rows || [];

    for (const row of rows) {
      const match = row;
      if (!match.startTime || !match.endTime) continue;

      // ✅ Parse times properly (handles strings like "2025-10-10T02:21" too)
      const startTime = new Date(match.startTime);
      const endTime = new Date(match.endTime);
      const nowTime = now.getTime();

      if (isNaN(startTime) || isNaN(endTime)) {
        console.warn(`⚠️ Invalid date for match ${match.id}`);
        continue;
      }

      let statusChanged = false;

      // 🟢 If match is upcoming and current time is between start & end
      if (match.status === "upcoming" && nowTime >= startTime.getTime() && nowTime < endTime.getTime()) {
        match.status = "live";
        statusChanged = true;
        console.log(`▶️ Match ${match.id} is now LIVE`);
      }

      // 🔴 If match is live or upcoming but current time has passed end time
      else if (["upcoming", "live"].includes(match.status) && nowTime >= endTime.getTime()) {
        match.status = "completed";
        statusChanged = true;
        console.log(`🏁 Match ${match.id} marked COMPLETED`);

        // ✅ Notify captains when match completes
        try {
          const myTeamDoc = await teams.get(match.myTeamId);
          const oppTeamDoc = await teams.get(match.opponentTeamId);
          const captains = [myTeamDoc.content.captain, oppTeamDoc.content.captain];

          await sendNotification(captains, {
            title: "Match Completed",
            matchId: match.id,
            message: `Match between ${myTeamDoc.content.name} and ${oppTeamDoc.content.name} is completed. Please submit match stats.`,
            date: new Date().toISOString(),
          });

          //console.log(`📩 Captains notified for match ${match.id}`);
        } catch (notifyErr) {
          console.error(`❌ Notification error for match ${match.id}:`, notifyErr.message);
        }
      }

      // ✅ Save update if status changed
      if (statusChanged) {
        match.updatedAt = new Date().toISOString();
        await matches.upsert(match.id, match);
        console.log(`⚡ Match ${match.id} status updated to "${match.status}"`);
      }
    }

    console.log("✅ Match status updater finished.\n");
  } catch (err) {
    console.error("❌ Match status updater error:", err);
  }
});

// ---- Server Start ----
const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`🚀 Server running on http://localhost:${PORT}`);
});
