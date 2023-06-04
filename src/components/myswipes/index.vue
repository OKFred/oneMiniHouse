<template>
  <van-swipe-cell :right-width="200" style="flex-direction: column; font-size: 1.2rem">
    <van-cell-group custom-class="my-cell-group">
      <van-cell :border="false" custom-class="my-cell">
        <view class="my-swipe-card">
          <slot name="mySwipeSlot">
            <view style="height: 2.5rem;" class="my-center-vertically">
              <view style="margin: 1rem"> 滑动菜单内容 </view>
            </view>
          </slot>
        </view>
      </van-cell>
    </van-cell-group>
    <slot-view :name="'right'">
      <view class="my-center my-swipe-button" style="color: white; font-size: 1rem;">
        <view class="my-center my-center-vertically" style="background-color: #fa5151; width: 100px">
          修改
        </view>
        <view class="my-center my-center-vertically" style="background-color: #7b7b7b; width: 100px">
          删除
        </view>
      </view>
    </slot-view>
  </van-swipe-cell>
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
  parentObj: Object,
});

</script>

<style>
.my-cell {
  padding: 0rem !important;
  background-color: transparent !important;
}

.my-cell-group {
  margin-top: 1rem !important;
}

.my-swipe-card {
  height: 4rem;
  background-color: white;
}

.my-swipe-button {
  height: 4rem;
}
</style>
