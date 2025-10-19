import { connect } from "couchbase";
import ImageKit from "imagekit";
import dotenv from "dotenv";

dotenv.config();

let cluster;
let scope;

async function tryConnect() {
  return await connect(process.env.COUCHBASE_CONN_STRING, {
    username: process.env.COUCHBASE_USERNAME,
    password: process.env.COUCHBASE_PASSWORD,
    timeouts: {
      kvTimeout: 15000,      // 10s
      queryTimeout: 15000,   // 15s
      connectTimeout: 15000, // 15s
    },
  });
}

// Couchbase init with retry
export async function initDB(retries = 50, delay = 3000) {
  if (scope) return scope;

  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      cluster = await tryConnect();
      const bucket = cluster.bucket(process.env.COUCHBASE_BUCKET);
      scope = bucket.scope(process.env.COUCHBASE_SCOPE);

      console.log("✅ Couchbase connected");
      return scope;
    } catch (err) {
      console.error(`❌ Couchbase connection failed (attempt ${attempt}/${retries}):`, err.message);

      if (attempt < retries) {
        console.log(`⏳ Retrying in ${delay / 1000}s...`);
        await new Promise(res => setTimeout(res, delay));
      } else {
        console.error("🚨 Max retries reached. Exiting...");
        process.exit(1); // ya throw err
      }
    }
  }
}

export function getCollection(name) {
  if (!scope) throw new Error("DB not initialized. Call initDB() first!");
  return scope.collection(name);
}

export function getCluster() {
  return cluster;
}

// ImageKit init
export const imagekit = new ImageKit({
  publicKey: process.env.IMAGEKIT_PUBLIC_KEY,
  privateKey: process.env.IMAGEKIT_PRIVATE_KEY,
  urlEndpoint: process.env.IMAGEKIT_URL_ENDPOINT,
});
