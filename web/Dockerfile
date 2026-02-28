FROM node:24-alpine
WORKDIR /app
ARG NEXT_PUBLIC_API_BASE
ENV NEXT_PUBLIC_API_BASE=${NEXT_PUBLIC_API_BASE}
COPY package.json /app/
RUN npm install --include=dev
COPY . /app
RUN npm run build
EXPOSE 3000
CMD ["npm","run","start"]
