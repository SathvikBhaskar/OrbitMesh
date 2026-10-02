import { db } from "./src/db/client";
import { users } from "./src/db/schema";
import bcrypt from "bcryptjs";

async function createAdmin() {
  try {
    const passwordHash = await bcrypt.hash("admin123", 10);
    const [user] = await db
      .insert(users)
      .values({
        email: "admin@orbitmesh.com",
        passwordHash,
        role: "ADMIN",
      })
      .returning();
    console.log(`Successfully created ADMIN user: ${user.email} (ID: ${user.id})`);
  } catch (err: any) {
    if (err.code === "23505") {
      console.error("Error: A user with that email already exists.");
    } else {
      console.error("Error creating admin:", err);
    }
  } finally {
    process.exit(0);
  }
}

createAdmin();
