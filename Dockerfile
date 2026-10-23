FROM node:22-slim

WORKDIR /app

COPY package.json *.mjs ./

# База (db.json) пишется в /app/data — на bothost эта папка переживает обновления.
CMD ["node", "bot.mjs"]
