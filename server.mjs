import { mkdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import Database from "better-sqlite3";
import express from "express";
import { rateLimit } from "express-rate-limit";
import helmet from "helmet";

const projectDirectory = dirname(fileURLToPath(import.meta.url));
const allowedPositions = new Set(["First speaker", "Second speaker", "Third speaker", "Fourth speaker", "Undecided", "Other"]);
const maximumIntroductionLength = 1000;

export function createDatabase(databasePath) {
  const database = new Database(databasePath);
  database.pragma("busy_timeout = 5000");
  database.exec(`
    CREATE TABLE IF NOT EXISTS signups (
      id INTEGER PRIMARY KEY,
      full_name TEXT NOT NULL CHECK (length(full_name) BETWEEN 2 AND 40),
      grade TEXT NOT NULL CHECK (length(grade) BETWEEN 1 AND 40),
      phone TEXT NOT NULL CHECK (length(phone) BETWEEN 6 AND 30),
      position TEXT NOT NULL CHECK (position IN ('First speaker', 'Second speaker', 'Third speaker', 'Fourth speaker', 'Undecided', 'Other')),
      introduction TEXT NOT NULL CHECK (length(introduction) BETWEEN 10 AND 1000),
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
  `);
  return database;
}

function validateSignup(body) {
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    return { error: "Please submit valid signup information." };
  }

  const fullName = typeof body.fullName === "string" ? body.fullName.trim() : "";
  const grade = typeof body.grade === "string" ? body.grade.trim() : "";
  const phone = typeof body.phone === "string" ? body.phone.trim() : "";
  const position = typeof body.position === "string" ? body.position.trim() : "";
  const introduction = typeof body.introduction === "string" ? body.introduction.trim() : "";
  const honeypot = typeof body.website === "string" ? body.website.trim() : "";

  if (honeypot) return { error: "We could not verify this submission. Please check the form and try again." };
  if (fullName.length < 2 || fullName.length > 40) return { error: "Name must be 2–40 characters long." };
  if (grade.length < 1 || grade.length > 40) return { error: "Please enter a valid grade (up to 40 characters)." };
  if (phone.length < 6 || phone.length > 30 || !/^[0-9+()\-\s]+$/.test(phone)) {
    return { error: "Please enter a valid phone number." };
  }
  const phoneDigits = phone.replace(/\D/g, "");
  if (phoneDigits.length < 6 || phoneDigits.length > 20) return { error: "Please enter a valid phone number." };
  if (!allowedPositions.has(position)) return { error: "Please select a valid preferred position." };
  if (introduction.length < 10 || introduction.length > maximumIntroductionLength) {
    return { error: "Self-introduction must be 10–1000 characters long." };
  }

  return { value: { fullName, grade, phone, position, introduction } };
}

export function createApp(database, { signupLimit = 5, signupWindowMs = 15 * 60 * 1000 } = {}) {
  const app = express();
  app.disable("x-powered-by");
  app.use(helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        baseUri: ["'self'"],
        connectSrc: ["'self'"],
        formAction: ["'self'"],
        frameAncestors: ["'none'"],
        imgSrc: ["'self'", "data:"],
        objectSrc: ["'none'"],
        scriptSrc: ["'self'", "'unsafe-inline'"],
        styleSrc: ["'self'", "'unsafe-inline'"]
      }
    }
  }));

  const signupLimiter = rateLimit({
    windowMs: signupWindowMs,
    limit: signupLimit,
    standardHeaders: "draft-8",
    legacyHeaders: false,
    message: { error: "Too many submissions. Please try again later." }
  });

  app.use("/api", (_request, response, next) => {
    response.set("Cache-Control", "no-store");
    next();
  });

  app.get(["/", "/index.html"], (_request, response) => {
    response.sendFile(join(projectDirectory, "index.html"));
  });

  app.post("/api/signups", signupLimiter, express.json({ limit: "10kb", strict: true }), (request, response) => {
    if (!request.is("application/json")) {
      return response.status(415).json({ error: "Please submit signup information in JSON format." });
    }

    const validation = validateSignup(request.body);
    if (validation.error) return response.status(400).json({ error: validation.error });

    try {
      const insertSignup = database.prepare(`
        INSERT INTO signups (full_name, grade, phone, position, introduction)
        VALUES (@fullName, @grade, @phone, @position, @introduction)
      `);
      insertSignup.run(validation.value);
      return response.status(201).json({ message: "Signup information submitted." });
    } catch (error) {
      console.error("Failed to save signup information.", error instanceof Error ? error.name : "UnknownError");
      return response.status(503).json({ error: "Signup information could not be saved right now. Please try again later." });
    }
  });

  app.use("/api", (_request, response) => {
    response.status(404).json({ error: "Endpoint not found." });
  });

  app.use((error, _request, response, _next) => {
    if (error?.type === "entity.too.large") {
      return response.status(413).json({ error: "Submission is too large. Please shorten it and try again." });
    }
    if (error instanceof SyntaxError && "body" in error) {
      return response.status(400).json({ error: "Invalid signup information format. Please check and try again." });
    }
    console.error("Request handling failed.", error instanceof Error ? error.name : "UnknownError");
    return response.status(500).json({ error: "The server cannot process the request right now. Please try again later." });
  });

  return app;
}

async function startServer() {
  const dataDirectory = resolve(process.env.DATA_DIR || join(projectDirectory, "data"));
  await mkdir(dataDirectory, { recursive: true });
  const database = createDatabase(join(dataDirectory, "signups.sqlite"));
  const app = createApp(database);
  const port = Number(process.env.PORT || 3000);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("PORT must be an integer between 1 and 65535.");
  }

  const server = app.listen(port, () => {
    console.log(`Debate club website listening on port ${port}.`);
  });
  const close = () => {
    server.close(() => {
      database.close();
      process.exit(0);
    });
  };
  process.on("SIGINT", close);
  process.on("SIGTERM", close);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  startServer().catch((error) => {
    console.error("Server startup failed.", error instanceof Error ? error.message : "UnknownError");
    process.exitCode = 1;
  });
}
