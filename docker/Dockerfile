# Using 18 alpine because supports arm/v8 and arm/v8 needed for silicon chips
FROM node:18-alpine
# bash only. There is deliberately NO node-gyp toolchain (python3/make/g++) here:
# nothing in the dependency tree compiles native code any more. metaapi.cloud-sdk
# was the only package that pulled in a hard bufferutil/utf-8-validate dependency;
# `ws` (via parse-server) merely lists them as OPTIONAL peers, which npm does not
# install. Adding the toolchain "just in case" costs ~25 minutes of build time on
# this image, so if a future dependency needs it, add it back deliberately.
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
