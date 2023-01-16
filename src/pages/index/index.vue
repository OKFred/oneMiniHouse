<template>
  <mytaro />
  <myHeaderd :parentObj="localObj" />
  <view class="my-underground" />
  <mycontents>
    <slot-view :name="'myContentSlot'" style="margin: 6rem 0">
      <view style="margin-top: 1rem" />
      <view class="my-center">
        <!-- <image :src="banner" style="height: 140px; width: 343px" mode="widthFix" /> -->
      </view>
      <theMenu :localObj="localObj" />
    </slot-view>
  </mycontents>
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
import mytaro from "@/src/components/mytaro/index.vue" //公共页面配置
import myHeaderd from "@/src/components/myheaderd/index.vue"; //引入公共组件
import theMenu from "./components/theMenu.vue" //引入自定义组件
// import banner from "@/src/assets/banner.png"; //引入图片

definePageConfig({
  navigationStyle: "custom",
  enableShareTimeline: true,
  enableShareAppMessage: true,
  usingComponents: {
    mycontents: "@/src/components/mycontents/index",
  },
});

//父系入参
const { onNav, onNavBack } = globalThis.app;

const props = defineProps({
  globalObj: Object,
});

onMounted(() => {
  globalThis.app.changeTab({ tabName: "首页" });
  // fetchData()
});

function setData(obj = {}) {
  Object.assign(localObj, obj);
  return localObj;
} //微信setData替代品

//本地变量和函数
let localObj = reactive({
  pageName: "首页",
  headerColor: "white",
  // showBackButton: true,
});

async function fetchData() {
  let queryObj = globalThis.prepareMsg("保存前端日志");
  let queryMsg = await doFetch(queryObj);
  console.log(queryMsg);
}
</script>

<style>

</style>
