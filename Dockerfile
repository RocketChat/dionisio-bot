FROM node:18-slim
WORKDIR /usr/src/app
COPY package.json package-lock.json ./
RUN npm ci --production
RUN npm cache clean --force
ENV NODE_ENV="production" LOG_LEVEL="error"
COPY . .
CMD [ "npm", "start" ]
