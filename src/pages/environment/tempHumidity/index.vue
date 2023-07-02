<template>
  <myUview :globalObj="globalObj" v-if="localObj.pageShow" />
  <myHeader :parentObj="localObj">
    <template #myHeaderSlot>
      <theTab :localObj="localObj" />
      <theSelector :localObj="localObj" />
    </template>
  </myHeader>
  <view class="my-underground-purple" />
  <view v-show="localObj.tabs?.currentTab === '文本'">
    <view style="margin-top: 1vh" />
    <theForm :localObj="localObj" />
  </view>
  <view v-show="localObj.tabs?.currentTab === '图表'">
    <view style="margin-top: 1vh" />
    <theChart :localObj="localObj" />
  </view>
  <view style="padding-bottom: 10vh;" />
  <theFooter :localObj="localObj" />
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
import { onLoad, onShow, onHide, onReachBottom } from "@dcloudio/uni-app";
import { fetchData, fakeData } from './components/data.js'; //引入数据

//组件引入
import myUview from "/src/components/my-uview/index.vue";
import myHeader from "/src/components/my-header/index.vue";
import theTab from "./components/theTab.vue";
import theSelector from "./components/theSelector.vue";
import theFooter from "./components/theFooter.vue";
import theForm from "./components/theForm.vue";
import theChart from "./components/theChart.vue";

//父系入参
const { onNav, onNavBack, globalData } = globalThis.app;

const props = defineProps({
  globalObj: Object,
});

//本地变量和函数
let localObj = reactive({
  pageName: "温湿度",
  headerColor: "#9acafc",
  titleStyle: "font-size: 1.3rem !important; font-weight: bold; color: white !important;",
  showBackButton: true,
  pageShow: false,
  fn: {},
});

onLoad(async () => {
  await loadData({ options: ['users'] })
})

onShow(async () => {
  localObj.pageShow = true;
});

onHide(() => {
  localObj.pageShow = false;
})

async function loadData({ options, lists, codes, deletes, completes } = {}) {
  if (options) {
    let optionArr = await fakeData({ options });
    if (!optionArr) return //globalThis.queryResult(false, '删除请求失败');
    setOptions(optionArr);
  }
}

function setOptions(optionArr) {
  if (!optionArr) return //globalThis.queryResult(false, '获取选项失败');
  let finalOptionObj = {};
  for (let { tag, list } of optionArr) {
    finalOptionObj[tag] = [/* { name: '清空', label: "清空", text: '清空', ['选中']: true, value: "" }, */ ...list.map((obj) => {
      return { ...obj, label: obj.name, text: obj.name, value: obj.id }
    })]
  }
  localObj.options = finalOptionObj;
  localObj.selectors?.forEach(formObj => {
    formObj.options = finalOptionObj;
  });
  let formObj_selectors = localObj.selectors.find(obj => obj.parent === '用户表单');
  let userObj = formObj_selectors.formArr.find(obj => obj.label === '当前用户');
  userObj.value = finalOptionObj.users[0].value;
  userObj.name = finalOptionObj.users[0].name;
  localObj.addressUpdate?.(userObj.value);
  console.log('选项', localObj.options);
}
</script>

<style></style>
