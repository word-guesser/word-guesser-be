#!/bin/bash

export IMAGE_NAME="word-guesser"
export TAG=v$(node -p "require('./package.json').version")
export NAME="resolved617"
docker tag $IMAGE_NAME:latest $NAME/$IMAGE_NAME:$TAG
docker tag $IMAGE_NAME:latest $NAME/$IMAGE_NAME:latest

docker push $NAME/$IMAGE_NAME:$TAG
docker push $NAME/$IMAGE_NAME:latest