<template>
  <!-- 一个主要的操作按钮，用于登录提交返回等场景 -->
  <van-button
    :custom-class="`my-botton my-center ${parentObj.color === 'orange' ? 'my-orange-button' : parentObj.color === 'blue-plain' ? 'my-blue-plain' : parentObj.color === 'red-plain' ? 'my-red-plain' : 'my-blue-button'} ${parentObj.size === 'small' ? 'my-small-button' : parentObj.size === 'small' ? 'my-small-button' : parentObj.size === 'medium' ? 'my-medium-button' : 'my-large-button'}`"
    block="true" :round="parentObj.shape !== 'square'" :icon="parentObj.icon" :disabled="parentObj.disabled">
    <text>{{ parentObj.text }}</text>
  </van-button>
</template>

<script setup>
import Taro from "@tarojs/taro";
import { reactive, watch, onMounted } from "vue";

//父系入参
const props = defineProps({
  parentObj: {
    type: Object,
    /*     default: {
          text: {
            type: String,
          },
          icon: {
            type: String,
          },
          color: {
            type: String,
          },
          size: {
            type: String,
          },
          shape: {
            type: String,
          },
          disabled: {
            type: Boolean,
          },
        } */
  }
});

definePageConfig({
  navigationStyle: "custom",
  usingComponents: {
    "van-button": "@vant/weapp/button/index"
  },
});

</script>

<style>
/* 主按钮 */
.my-botton {
  font-weight: 550;
  font-size: 1.2rem !important;
  border: 0 !important;
  color: white !important;
}

.my-large-button {
  height: 3.7rem !important;
}

.my-medium-button {
  height: 3rem !important;
}

.my-small-button {
  height: 2.75rem !important;
}

.my-blue-button {
  /* background: linear-gradient(to right, #78AFF2, #348EFB) !important; */
  background-color: #008DFF !important;
  box-shadow: 0px 4px 8px rgba(49, 140, 251, 0.3);
}

.my-blue-plain {
  color: #008DFF !important;
  border: solid 1px #008DFF !important;
}

.my-red-plain {
  color: #FA5151 !important;
  border: solid 1px #FA5151 !important;
}

.my-orange-button {
  background: linear-gradient(to right, #FF8A3E, #FB5315) !important;
}
</style>
