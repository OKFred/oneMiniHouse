<template>
  <canvas :style="`width: 325px; height:375px; position: fixed; top: 0px; left: 0px; z-index: -4;`"
    canvas-id="secondCanvas" id="secondCanvas" v-if="localObj.makingCanvas"></canvas>
  <!-- 由于weapp-qrcode作用域的限制，需要将canvas放到最外层组件👇 -->
  <!-- <canvas style="width: 132px; height: 132px; position: fixed; top: 50px; left: 25px; z-index: -3;"
    canvas-id="myQrcode"></canvas> -->
  <!-- 盖一层视图，用于隐藏 -->
  <!-- <view style="width: 132px; height: 132px; position: fixed; top: 50px; left: 25px; z-index: -2; background-color: white;"></view> -->
</template>

<script setup>
//框架引入
import {
  reactive,
  watch,
  computed,
  onMounted,
  onActivated,
  onDeactivated,
  onUpdated,
  getCurrentInstance,
  defineProps,
} from "vue";
// import * as toCanvas /* { styleToCanvas, tableToCanvas, titleToCanvas, textToCanvas, hrToCanvas, imageToCanvas } */ from "./toCanvas.js";
import drawQrcode from 'weapp-qrcode' //引入二维码生成器
import { imageToAlbum } from './toImage.js'; //引入图片保存器

//组件引入

//父系入参
const props = defineProps({
  parentObj: Object,
});

function setData(obj) {
  Object.assign(props.parentObj, obj);
}

//本地变量和函数
setData({
  toggleCanvas,
  getContext,
  saveAsImage,
  getQRCode,
  canvasToURL
});

let localObj = reactive({
  makingCanvas: false,
});

//canvas中需要用到instance
let proxy, instance;
onMounted(() => {
  instance = getCurrentInstance();
  proxy = instance.proxy;
  localObj.instance = instance;
  localObj.proxy = proxy;
  // console.log(proxy); 
}); //只有在onMounted中才能获取到instance

function getContext() {
  const ctx = uni.createCanvasContext("secondCanvas", instance);
  return ctx;
} //获取canvas上下文

function toggleCanvas() {
  localObj.makingCanvas = !localObj.makingCanvas;
  console.log('当前canvas状态：', localObj.makingCanvas ? '显示' : '隐藏')
} //切换canvas

async function canvasToURL(canvasId, instance) {
  return await new Promise((resolve, reject) =>
    uni.canvasToTempFilePath({
      fileType: 'jpg', //不用png，免得出现黑色背景
      quality: '1', // 图片质量
      canvasId,
      success: function (res) {
        resolve(res.tempFilePath);
      },
      fail: function (res) {
        console.log(res);
        resolve(false);
      }
    }, instance));
} //canvas转换为图片链接

async function getQRCode(obj = {}) {
  if (!obj || !obj.canvasId || !props.parentObj.instance) return false;
  await new Promise((resolve, reject) => drawQrcode({
    ...obj,
    callback: (e) => {
      resolve(e);
    },
  }));
  let url = await canvasToURL(obj.canvasId, props.parentObj.instance);
  // console.log(url)
  return url;
} //生成二维码链接

async function saveAsImage(canvasId) {
  let url = await canvasToURL(canvasId, instance)
  console.log(url) //html下为base64，小程序下为临时链接
  if (/^http/.test(url)) return imageToAlbum(url);
  uni.previewImage({
    current: url, // 当前显示图片的http链接
    urls: [url], // 需要预览的图片http链接列表
    complete: imageToAlbum(url) //预览完成后询问是否保存图片
  })
} //保存图片
</script>

<style></style>
