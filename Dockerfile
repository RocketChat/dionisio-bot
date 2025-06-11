FROM node:22-slim

WORKDIR /usr/src/app

COPY . .

RUN corepack enable && yarn install && yarn build

ENV NODE_ENV="production"

CMD [ "yarn", "start" ]
