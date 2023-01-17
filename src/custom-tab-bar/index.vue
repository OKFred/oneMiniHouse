<template>
  <myfooters v-if="localObj.footerArr && localObj.footerArr.length">
    <template #myFooterSlot>
      <view v-for="(item, index) in localObj.footerArr" :key="index" :data-obj="item"
        class="my-center my-center-vertically" style="width: 100%; flex-direction: column"
        @tap="onNav({ pageName: item.page, navType: item.type })">
        <image v-if="item.active && item.src[0]" style="height: 40px; width: 40px;" :src="item.src[0]"
          mode="heightFix" />
        <image v-if="!item.active && item.src[1]" style="height: 40px; width: 40px;" :src="item.src[1]"
          mode="heightFix" />
        <view class="my-font" :style="
          'margin-top: 0.2rem; color:' + item.active ? '#4496F9' : '#BDD2EC'
        ">
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
import icon_home_selected from "@/src/assets/home_selected.svg"; //引入图片
import icon_home_unselected from "@/src/assets/home_unselected.svg"; //引入图片
import icon_me_selected from "@/src/assets/me_selected.svg"; //引入图片
import icon_me_unselected from "@/src/assets/me_unselected.svg"; //引入图片

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
      src: [icon_home_selected, icon_home_unselected],
      active: true,
      disabled: true, //同一页面禁止点击
    },
    {
      label: "我的",
      page: "我的",
      type: "switchTab",
      src: [icon_me_selected, icon_me_unselected],
      active: false,
    },
  ],
});

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

</style>
