FROM node:22-alpine

# 1. Install build dependencies required for native modules (bcrypt)
RUN apk add --no-cache python3 make g++

WORKDIR /app

COPY package*.json ./

# 2. Remove --ignore-scripts so bcrypt can compile its native binary
RUN npm ci

COPY tsconfig.json ./
COPY src ./src

RUN npm run build

COPY init.sql ./init.sql

# 3. Secure the application
RUN addgroup -S appgroup && adduser -S appuser -G appgroup
RUN chown -R appuser:appgroup /app
USER appuser

EXPOSE 4000

CMD ["npm", "start"]