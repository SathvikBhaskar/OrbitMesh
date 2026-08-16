FROM node:20-alpine

WORKDIR /app

# Install dependencies
COPY package*.json ./
RUN npm install

# Copy source
COPY . .

# Build backend
RUN npm run build

# Expose port
EXPOSE 3000

# Script to wait for db, migrate, seed and start
# We use a simple shell command instead of a separate file
CMD npx drizzle-kit migrate && npm run db:seed && npm start
