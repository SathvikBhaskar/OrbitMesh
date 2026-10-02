import { db } from "../db/client";
import { users } from "../db/schema";
import bcrypt from "bcryptjs";
import readline from "readline";

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
});

function question(query: string): Promise<string> {
  return new Promise((resolve) => rl.question(query, resolve));
}

async function createAdmin() {
  console.log("=== OrbitMesh Admin Bootstrap ===");
  try {
    const email = await question("Admin Email: ");
    if (!email.includes("@")) {
      console.error("Invalid email format.");
      process.exit(1);
    }

    const password = await question("Admin Password: ");
    if (password.length < 8) {
      console.error("Password must be at least 8 characters.");
      process.exit(1);
    }

    const passwordHash = await bcrypt.hash(password, 10);

    const [user] = await db
      .insert(users)
      .values({
        email,
        passwordHash,
        role: "ADMIN",
      })
      .returning();

    if (user) {
      console.log(`\nSuccessfully created ADMIN user: ${user.email} (ID: ${user.id})`);
    } else {
      console.log(`\nFailed to create ADMIN user.`);
    }
  } catch (err: any) {
    if (err.code === "23505") {
      console.error("Error: A user with that email already exists.");
    } else {
      console.error("Error creating admin:", err);
    }
  } finally {
    rl.close();
    process.exit(0);
  }
}

createAdmin();
