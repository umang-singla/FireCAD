FROM node:24-alpine
WORKDIR /app
ARG NEXT_PUBLIC_API_BASE
ENV NEXT_PUBLIC_API_BASE=${NEXT_PUBLIC_API_BASE}
ARG NEXT_PUBLIC_WS_BASE
ENV NEXT_PUBLIC_WS_BASE=${NEXT_PUBLIC_WS_BASE}
COPY package.json /app/
COPY patches /app/patches
RUN npm install --include=dev
COPY . /app
RUN npm run build
EXPOSE 3000
CMD ["npm","run","start"]
