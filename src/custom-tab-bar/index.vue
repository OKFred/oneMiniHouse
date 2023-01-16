<template>
  <myfooters v-if="localObj.footerArr && localObj.footerArr.length">
    <template #myFooterSlot>
      <view
        v-for="(item, index) in localObj.footerArr"
        :key="index"
        :data-obj="item"
        class="my-center my-center-vertically"
        style="width: 100%; flex-direction: column"
        @tap="onNav({ pageName: item.page, navType: item.type })"
      >
        <image
          v-if="item.active && item.src[0]"
          style="height: 40px"
          :src="item.src[0]"
          mode="heightFix"
        />
        <image
          v-if="!item.active && item.src[1]"
          style="height: 40px"
          :src="item.src[1]"
          mode="heightFix"
        />
        <view
          class="my-font"
          :style="
            'margin-top: 0.2rem; color:' + item.active ? '#4496F9' : '#BDD2EC'
          "
        >
          {{ item.label }}
        </view>
      </view>
    </template>
  </myfooters>
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
import myfooters from "@/src/components/myfooters/index.vue"; //引入组件
import tabHomeH from "@/src/assets/icon_tab_home_h.png"; //引入图片
import tabHomeN from "@/src/assets/icon_tab_home_n.png"; //引入图片
import tabMeH from "@/src/assets/icon_tab_me_h.png"; //引入图片
import tabMeN from "@/src/assets/icon_tab_me_n.png"; //引入图片

definePageConfig({
  usingComponents: {
    // myfooters: "@/src/components/myfooters/index",
  },
});

//父系入参
let app = globalThis.app;
const { onNav, onNavBack } = app;

const props = defineProps({
  globalObj: Object,
});

//本地变量和函数
let localObj = reactive({
  footerArr: [
    {
      label: "首页",
      page: "首页",
      type: "switchTab",
      src: [tabHomeH, tabHomeN],
      active: true,
      disabled: true, //同一页面禁止点击
    },
    {
      label: "我的",
      page: "我的",
      type: "switchTab",
      src: [tabMeH, tabMeN],
      active: false,
    },
  ],
});

/*
watch(
    () => props.globalObj.msgs[localObj.name],
    (newValue, oldValue) => {
        if (newValue) distribute(newValue)
    },
    { immediate: true },
) //处理来自App.vue的消息分发 */

function changeTab({ tabName } = {}) {
  let { footerArr } = localObj;
  footerArr = footerArr.map((obj) => {
    obj.disabled = false;
    obj.active = false;
    return obj;
  });
  let footerObj = footerArr.find((obj) => obj.label === tabName) || {};
  footerObj.active = true;
  footerObj.disabled = true;
  console.log("切换了标签页");
}

globalThis.app.changeTab = changeTab; //注册全局函数
</script>

<style>
/* 引用全局样式 */
@import "../app.css";
</style>
