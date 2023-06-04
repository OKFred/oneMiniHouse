<template>
  <view v-for="(arr, i) in localObj.menus.finalMenuArr" :key="i" style="padding: 0 5vw; " class="my-menu">
    <view style="padding: 3vh 0 1vh;" class="my-heading">{{ localObj.menus.finalTitleArr[i] }}</view>
    <view class="" style="background-color: white; padding: 1vh 0; border-radius: 0.5rem;">
      <view v-for="(item, index) in arr" :key="index" @tap="onMenu(item)">
        <view class="my-center my-center-vertically"
          :style="`flex-direction: column; padding-top: 1.5vh; ${arr.length && index < arr.length - 1 ? 'border-bottom: 1px dashed #ecf5ff' : ''}`">
          <image style="width: 2rem; height: 2rem" :src="item.src" mode="widthFix" />
          <view style="padding: 2vh 0; font-weight: bold; font-size: 0.93rem;">
            {{ item.label }}
          </view>
        </view>
      </view>
    </view>
  </view>
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
  defineProps,
} from "vue";

//组件引入

//图片-支出
import icon_electricity from "/src/static/assets/electricity.svg";
import icon_tempHumidity from "/src/static/assets/tempHumidity.svg";
import icon_sound from "/src/static/assets/sound.svg";
import icon_light from "/src/static/assets/light.svg";
import icon_mix from "/src/static/assets/mix.svg";

//父系入参
const { onNav, onNavBack, globalData } = globalThis.app;

const props = defineProps({
  localObj: Object,
});

function setData(obj = {}) {
  Object.assign(props.localObj, obj);
  return props.localObj;
} //微信setData替代品

//本地变量和函数
setData({
  menus: {
    menuArr: [
      {
        parent: "支出",
        label: "电表",
        page: "支出-电表",
        src: icon_electricity,
      },
      {
        parent: "环境",
        label: "综合检测",
        page: "环境-综合检测",
        src: icon_mix,
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
      {
        parent: "环境",
        label: "光照",
        page: "环境-光照",
        src: icon_light,
      },
    ],
    finalMenuArr: [],
    finalTitleArr: [],
  }
});

onMounted(() => {
  menuConfig();
});

function menuConfig() {
  let menuExpenseArr = props.localObj.menus.menuArr.filter((obj) => obj.parent === "支出")
  let menuEnvironmentArr = props.localObj.menus.menuArr.filter((obj) => obj.parent === "环境")
  let menuOtherArr = props.localObj.menus.menuArr.filter((obj) => obj.parent === "其他")
  let menuReportArr = props.localObj.menus.menuArr.filter((obj) => obj.parent === "报表")
  let menuBasicArr = props.localObj.menus.menuArr.filter((obj) => obj.parent === "基础")
  props.localObj.menus.finalMenuArr = [menuExpenseArr, menuEnvironmentArr/* , menuOtherArr, menuReportArr, menuBasicArr */]
  props.localObj.menus.finalTitleArr = ["支出", "环境"/* , "其他", "报表", "基础" */]
}

function onMenu({ page, disabled, paramObj = {} } = {}) {
  if (disabled) return console.log("按钮已禁用");
  return onNav({ pageName: page });
}

</script>

<style>
.my-menu {
  display: flex;
  flex-direction: column;
  border-radius: 0.5rem;
  font-size: 1.2rem;
}

.my-col-2 {
  display: grid;
  grid-template-columns: repeat(2, 1fr);
}

.my-col-3 {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
}

.my-col-4 {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
}
</style>
