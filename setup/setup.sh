#!/bin/bash
# FRED@2022
# 项目初始化脚本

npm install - g @tarojs/cli
npm install
mkdir ./src/components/vant-weapp
cp ./node_modules/@vant/weapp/dist/ ./src/components/vant-weapp/ -r
