FROM node:22-slim

WORKDIR /app

COPY package.json index.js *.mjs ./

# База (db.json) пишется в /app/data — на bothost эта папка переживает обновления.
CMD ["node", "index.js"]
