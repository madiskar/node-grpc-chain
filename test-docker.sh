#!/bin/bash

docker run --rm -it -v $PWD:/var/app node:12.18.2 bash -c "cd /var/app && yarn test"

