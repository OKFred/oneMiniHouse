<template>
  <view class="my-center-vertically my-search-area">
    <my-search :parentObj="localObj.searches" class="my-search-box" />
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
import mySearch from "/src/components/my-search/index.vue"

//父系入参
const { onNav, onNavBack, globalData } = globalThis.app;

const props = defineProps({
  localObj: Object,
});

function setData(obj) {
  Object.assign(props.localObj, obj);
}

//本地变量和函数
setData({
  searches: {
    onSearch,
    onIconClick,
    inFiltering,
    userSearch: '',
    /*     icon: '/src/static/assets/icon_funnel.png',
        icons: ['/src/static/assets/icon_funnel.png', '/src/static/assets/icon_funnel_selected.png'],
        iconLabel: '筛选',
        iconPosition: 'right', */
    placeholder: '搜索',
  }
});

function inFiltering(status) {
  props.localObj.searches.icon = props.localObj.searches.icons[status ? 1 : 0];
}

function onSearch(params) {
  let { e, value, parent } = params;
  return console.log("搜索", value);
  props.localObj.requestParamObj['keywords'] = value;
  props.localObj.fn.clearRequestHistory?.();
  props.localObj.fn.loadData?.({ lists: props.localObj.requestParamObj });
}

function onIconClick() {
  console.log("点击了搜索框旁边的图标");
  props.localObj.filters.toggleFilters?.();
}
</script>

<style>
/* 搜索框 */
.my-search-box {
  width: 100%;
  padding: 0 2vw;
  height: 5vh;
  display: inline-flex;
}

.my-search-area {
  width: 100%;
  height: 7vh;
  background-color: white;
  position: relative;
  z-index: 2;
}
</style>
