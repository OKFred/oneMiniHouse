<template>
  <view style="margin-top: 1rem" />
  <mytabd :parentObj="localObj.tabHistory" class="my-tab-history" />
  <view class="pur_item" v-for="(v, i) in localObj.tabHistory.tabArr.findIndex(
    (obj) => obj.label === localObj.tabHistory.currentTab
  ) + 1" :key="i">
    <van-swipe-cell :right-width="240" :class="i === localObj.tabHistory.tabArr.length - 1 ? 'my-last-cell' : ''">
      <van-cell-group>
        <van-cell :border="true" class="">
          <view class="main_item_box">
            <view class="main_item_name">车次: 1102290</view>
            <view class="main_item_del number">销售总量:1000kg</view>
            <view class="time_box">
              <view class="main_item_del time">销售总额:￥5000</view>
              <view style="font-weight: bold; font-size: 1rem">结余额:￥4900</view>
            </view>
          </view>
        </van-cell>
      </van-cell-group>
      <slot-view :name="'right'">
        <view class="operation_box">
          <view class="oper_edit item" @tap="onEdit"> 修改 </view>
          <view class="oper_see item" @tap="onSee">详情</view>
          <view class="oper_delete item"> 删除 </view>
        </view>
      </slot-view>
    </van-swipe-cell>
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
import mytabd from "/src/components/mytabd/index.vue";

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
  tabHistory: {
    onTabChange,
    currentTab: "草稿",
    tabArr: [
      { label: "草稿", value: undefined },
      { label: "已完成", value: undefined },
      { label: "已撤销", value: undefined },
    ],
    size: "small",
    color: "black",
    round: true,
  },
});

function onTabChange(params) {
  let { e, title, parent } = params;
  let confirmed = title === "草稿" ? 0 : 1;
  // clearRequestHistory();
  let { requestParamObj, tabHistory } = props.localObj;
  requestParamObj["keyName"] = confirmed;
  tabHistory.currentTab = title;
  setData({ requestParamObj, tabHistory });
  console.log("切换了标签");
  // fetchData();
} //切换标签则清理缓存

function onEdit() {
  // 采购单、图表
  console.log("修改----");
  Taro.navigateTo({
    url: "/pages/spend/purchase/pur_edit",
  });
}
function onSee() {
  Taro.navigateTo({
    url: "/pages/spend/purchase/pur_history",
  });
}
</script>

<style>
/* 标签栏置顶 */
.my-tab-history {
  width: 90%;
}

.my-last-cell>view {
  border-radius: 0 0 0.5rem 0.5rem;
}

.main_item_box {
  height: 152rpx;
  padding: 32rpx;
  /* background-color: darkkhaki; */
}

.operation_box {
  height: 216rpx;
  line-height: 216rpx;
  display: flex;
  align-items: center;
  text-align: center;
  justify-content: space-between;
  /* background-color: cadetblue; */
  color: #fff;
}

/* 组件单元格样式 S*/
.van-cell__value {
  text-align: left !important;
  color: #181818 !important;
}

.pur_item .van-cell {
  padding: 0 !important;
}

/* 组件单元格样式 E*/

.oper_edit {
  height: 100%;
  background-color: seagreen;
}

.oper_see {
  height: 100%;
  background-color: #008dff;
}

.oper_delete {
  height: 100%;
  background-color: red;
}

.operation_box .item {
  width: 160rpx;
}

/* 单元格内容样式 */
.main_item_name {
  font-size: 34rpx;
  font-family: Alibaba PuHuiTi;
  font-weight: 700;
  color: #181818;
}

.main_item_del {
  font-size: 30rpx;
  font-family: Alibaba PuHuiTi;
  font-weight: 400;
  color: #7b7b7b;
}

.number {
  margin-top: 18rpx;
}

.time_box {
  display: flex;
  justify-content: space-between;
}
</style>
