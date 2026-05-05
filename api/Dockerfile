FROM node:20-alpine

RUN apk add --no-cache python3 make g++ sqlite

WORKDIR /app

COPY package*.json ./
RUN npm install --production

COPY . .

EXPOSE 3456

CMD ["node", "server.js"]
