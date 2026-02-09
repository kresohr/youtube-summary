FROM node:22-alpine

WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src

RUN npm run build

COPY init.sql ./init.sql

EXPOSE 4000

CMD ["npm", "start"]
