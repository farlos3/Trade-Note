# Using 18 alpine because supports arm/v8 and arm/v8 needed for silicon chips
FROM node:18-alpine
RUN apk add --no-cache bash
WORKDIR /app

# Dependencies first, source second. This keeps the (slow) npm install in its own
# layer that is only invalidated when package.json actually changes — editing app
# code no longer forces a full reinstall on every build.
COPY package*.json ./
RUN npm install

COPY . .
RUN npm run build
CMD ["npm", "start"]
