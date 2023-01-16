<template>
  <button @tap="togglePlate">切换车牌键盘</button>
  <myplated :parentObj="localObj.plates" />
</template>

<script setup>
//框架引入
import Taro from "@tarojs/taro";
import {
  reactive,
  watch,
  computed,
  onMounted,
  onActivated,
  onDeactivated,
  onUpdated,
  defineProps,
} from "vue";

//组件引入
import myplated from "@/src/components/myplated/index.vue"  //引入组件

definePageConfig({
  navigationStyle: "custom",
  usingComponents: {
  },
});

//父系入参
const { onNav, onNavBack } = globalThis.app;

const props = defineProps({
  localObj: Object,
});

function togglePlate() {
  props.localObj.plates.showPlate = !props.localObj.plates.showPlate;
}

function onPlateEdit() {
  console.log('切换为自由编辑模式（配套输入框）')
  props.localObj.plates.editing = true;
  closeKeyboard()
} //改为自由编辑

function onPlateClose(params) {
  console.log("关闭车牌输入键盘");
  props.localObj.plates.showPlate = false;
}

function onPlateConfirm(params) {
  let { plateNumber } = params;
  console.log("已填写车牌号", plateNumber);
  closeKeyboard()
}

function showPowerBtn() {
  props.localObj.plates.showNewPower = true
  props.localObj.plates.KeyboardState = true
}
function closeKeyboard() {
  props.localObj.plates.KeyboardState = false
}
function openKeyboard() {
  props.localObj.plates.KeyboardState = true
}

function setData(obj) {
  Object.assign(props.localObj, obj);
}

//本地变量和函数
setData({
  // debug: true,
  plates: {
    numberArr: [],
    plateNumber: '',
    editing: false,
    showPlate: false,
    showNewPower: false,
    KeyboardState: false,
    onPlateClose,
    onPlateEdit,
    onPlateConfirm,
    showPowerBtn,
    closeKeyboard,
    openKeyboard
  },
});
</script>

<style>

</style>
