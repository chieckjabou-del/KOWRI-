import express, { type Express } from "express";
import cors from "cors";
import router from "./routes";
import { seedDatabase } from "./lib/seed";

const app: Express = express();

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use("/api", router);

seedDatabase().catch((err) => console.error("Seed error:", err));

export default app;
