require("dotenv").config();
const mongoose = require("mongoose");
const bcrypt = require("bcryptjs");

const appSchema = new mongoose.Schema({
  name: String, developer: String, category: String, description: String, logo: String,
  screenshots: [String], banner: String, price: Number, websiteUrl: String, downloadUrl: String,
  accessType: String, validity: String, rating: Number, downloads: Number,
  featured: Boolean, trending: Boolean, published: Boolean
}, { timestamps: true });
const adminSchema = new mongoose.Schema({
  username: { type: String, unique: true }, passwordHash: String, secretHash: String
}, { timestamps: true });

const App = mongoose.model("App", appSchema);
const Admin = mongoose.model("Admin", adminSchema);

(async () => {
  await mongoose.connect(process.env.MONGODB_URI);

  const username = process.env.ADMIN_USERNAME || "admin";
  const password = process.env.ADMIN_PASSWORD;
  const secret = process.env.ADMIN_SECRET_KEY;
  if (!password || !secret) throw new Error("Set ADMIN_PASSWORD and ADMIN_SECRET_KEY in environment before running seed.");

  const passwordHash = await bcrypt.hash(password, 12);
  const secretHash = await bcrypt.hash(secret, 12);

  await Admin.findOneAndUpdate({ username }, { username, passwordHash, secretHash }, { upsert: true, new: true });

  if (await App.countDocuments() === 0) {
    await App.insertMany([
      {
        name: "Study IQ", developer: "LALIT", category: "Education",
        description: "Competitive exam preparation, classes and study material.",
        logo: "https://placehold.co/256x256/111827/facc15?text=STUDY+IQ",
        screenshots: [
          "https://placehold.co/600x1000/0b0b0d/facc15?text=Course+Screen",
          "https://placehold.co/600x1000/0b0b0d/facc15?text=Course+Details",
          "https://placehold.co/600x1000/0b0b0d/facc15?text=Video+Player"
        ],
        banner: "https://placehold.co/1400x500/07111a/facc15?text=STUDY+IQ",
        price: 0, websiteUrl: "https://example.com", downloadUrl: "https://example.com",
        accessType: "free", validity: "Lifetime", rating: 4.8, downloads: 23000,
        featured: true, trending: true, published: true
      },
      {
        name: "UP PCS Prelims 2026 - Pratigya Crash Course", developer: "Rojgar With Ankit",
        category: "UPSC/UPPCS", description: "Demo course listing for STUDY PREMIUM COURSE.",
        logo: "https://placehold.co/256x256/111827/facc15?text=UPPCS",
        screenshots: ["https://placehold.co/600x1000/0b0b0d/facc15?text=Batch+Screen"],
        banner: "https://placehold.co/1400x700/08121d/facc15?text=UPPCS+2026",
        price: 799, websiteUrl: "https://example.com", downloadUrl: "https://example.com",
        accessType: "paid", validity: "Lifetime", rating: 4.9, downloads: 0,
        featured: true, trending: true, published: true
      },
      {
        name: "Rojgar With Ankit", developer: "RWA", category: "Government Exams",
        description: "Exam preparation platform listing.",
        logo: "https://placehold.co/256x256/111827/facc15?text=RWA",
        screenshots: ["https://placehold.co/600x1000/0b0b0d/facc15?text=Batches"],
        banner: "https://placehold.co/1400x500/121212/facc15?text=ROJGAR+WITH+ANKIT",
        price: 0, websiteUrl: "https://example.com", downloadUrl: "https://example.com",
        accessType: "free", validity: "Lifetime", rating: 4.9, downloads: 52900,
        featured: false, trending: true, published: true
      }
    ]);
  }

  console.log("Seed complete.");
  await mongoose.disconnect();
})().catch(err => { console.error(err); process.exit(1); });
