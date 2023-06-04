<template>
  <!-- 图表（弹框） -->
  <van-popup :show="localObj.pops.his_filter_show" round="true" position="bottom" :close-on-click-overlay="true"
    custom-style="height: 53vh;" @close="onFilterClose">
    <view class="oper_bod">
      <view class="oper_item">筛选</view>
      <view style=" height: 0.5rem; background: #F1F2F4;" />
      <view style="margin-top: 1rem" />
      <van-field input-class="my-field" :value="localObj.pops.his_fil_obj.startTime" placeholder="请选择车次" label="车次："
        input-align="right" right-icon="arrow" readonly="true" :border="true" @click-icon="onSupplierIcon" />
      <view style="margin-top: 1rem" />
      <van-field input-class="my-field" :value="localObj.pops.his_fil_obj.startTime" placeholder="请输入售货人姓名" label="售货人："
        input-align="right" readonly="true" :border="true" @click-icon="onCold_StorageIcon" />
      <view style="margin-top: 1rem" />
      <van-field input-class="my-field" :value="localObj.pops.his_fil_obj.startTime" placeholder="请选择时间" label="到货时间："
        input-align="right" right-icon="arrow" readonly="true" :border="true" @click-icon="onCold_StorageIcon" />
      <view style="margin-top: 1rem" />
      <van-field input-class="my-field" :value="localObj.pops.his_fil_obj.startTime" placeholder="请选择时间" label="售完时间："
        input-align="right" right-icon="arrow" readonly="true" :border="true" @click-icon="onCold_StorageIcon" />
    </view>
    <view class="total_box">
      <view class="_return" @tap="onFilterClose">重置</view>
      <view class="_button" @tap="onFilterClose">确定</view>
    </view>

  </van-popup>
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
  pops: {
    his_filter_show: false,
    his_fil_obj: {
      startTime: ""
    }
  }
});

function onSupplierIcon() {
  // 点击车次icon
  console.log("点击icon-----")
}
function onCold_StorageIcon() {
  // 点击冷库icon
  console.log("点击icon-----")
}
function onFilterClose() {
  // 筛选弹框
  props.localObj.pops.his_filter_show = false
}
</script>

<style>
.my-field {
  height: 56px;
}

/* 编辑操作 */
.oper_bod .oper_item {
  height: 112rpx;
  line-height: 112rpx;
  text-align: center;
  font-size: 34rpx;
  font-family: Alibaba PuHuiTi;
  font-weight: 400;
  color: #000000;
  border-top: 2rpx solid #F2F2F2;
}

/* 确定 */
.total_box {
  width: calc(100% - 64rpx);
  height: calc(160rpx - 64rpx);
  padding: 32rpx;
  margin-top: 46rpx;
  display: flex;
  justify-content: space-between;
  align-items: center;
  background: #FFFFFF;
  box-shadow: 0px -3px 20px rgba(0, 0, 0, 0.06);
  position: fixed;
  bottom: 0;
  right: 0;
  left: 0;
}

._return {
  width: 320rpx;
  height: 96rpx;
  text-align: center;
  line-height: 96rpx;
  border: 2rpx solid #008DFF;
  border-radius: 58rpx;
  font-size: 34rpx;
  font-family: Alibaba PuHuiTi;
  font-weight: 500;
  color: #008DFF;
}

._button {
  width: 320rpx;
  height: 96rpx;
  text-align: center;
  line-height: 96rpx;
  border-radius: 58rpx;
  color: #fff;
  font-size: 34rpx;
  background: #008DFF;
}
</style>
