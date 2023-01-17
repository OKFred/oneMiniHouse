<template>
  <view v-for="(arr, i) in [
    menuExpenseArr,
    menuEnvironmentArr,
    menuOtherArr,
    menuReportArr,
    menuBasicArr,
  ]" :key="i">
    <view style="padding: 1rem 0;">{{
      ["支出", "环境"/*, "其他", "报表", "基础" */][i]
    }}</view>
    <view class="my-col-3">
      <view v-for="(item, index) in arr" :key="index" :data-obj="item" @tap="onMenu"
        class="my-menu my-center my-center-vertically">
        <image style="width: 60px; height: 60px" :src="item.src" />
        <view style="margin-top: 0.5rem" class="my-font">
          {{ item.label }}
        </view>
      </view>
    </view>
  </view>
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

//图片-支出
import icon_electricity from "@/src/assets/electricity.svg";
import icon_tempHumidity from "@/src/assets/tempHumidity.svg";
import icon_sound from "@/src/assets/sound.svg";

definePageConfig({
  navigationStyle: "custom",
  usingComponents: {
    mycontents: "@/src/components/mycontents/index",
  },
});

//父系入参
const { onNav, onNavBack } = globalThis.app;

const props = defineProps({
  localObj: Object,
});

function setData(obj = {}) {
  Object.assign(props.localObj, obj);
  return props.localObj;
} //微信setData替代品

//本地变量和函数
setData({
  menuArr: [
    {
      parent: "支出",
      label: "电表",
      page: "支出-电表",
      src: icon_electricity,
    },
    {
      parent: "环境",
      label: "温湿度",
      page: "环境-温湿度",
      src: icon_tempHumidity,
    },
    {
      parent: "环境",
      label: "音量",
      page: "环境-音量",
      src: icon_sound,
    },
  ],
});

let menuExpenseArr = computed(() =>
  props.localObj.menuArr.filter((obj) => obj.parent === "支出")
);
let menuEnvironmentArr = computed(() =>
  props.localObj.menuArr.filter((obj) => obj.parent === "环境")
);
let menuOtherArr = computed(() =>
  props.localObj.menuArr.filter((obj) => obj.parent === "其他")
);
let menuReportArr = computed(() =>
  props.localObj.menuArr.filter((obj) => obj.parent === "报表")
);
let menuBasicArr = computed(() =>
  props.localObj.menuArr.filter((obj) => obj.parent === "基础")
);

function onMenu(e) {
  let { obj } = e.currentTarget.dataset; //item
  let { page, disabled } = obj || {};
  if (disabled) return console.log("按钮已禁用");
  return app.onNav({ pageName: page });
}

</script>

<style>
.my-menu {
  display: flex;
  flex-direction: column;
  border-radius: 1rem;
  background-color: white;
  font-size: 1.2rem;
  box-shadow: 0.1rem 0.2rem 0.1rem 0.1rem #efeef3;
  height: 8rem;
}

.my-col-3 {
  display: grid;
  grid-gap: 0.7rem;
  grid-template-columns: repeat(3, 1fr);
}
</style>
