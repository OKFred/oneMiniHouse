<template>
  <view :style="'height: 3.1rem; border-radius: 0; width:' + item.valueWidth || '100%' + ';'" :class=" item.inline ? 'my-form-inline' : '' " v-for="(item, index) in  _formArr" v-key="index">
    <view style="padding: 0.6rem 0.8rem 0.6rem 0.5rem; font-size: 1rem;" class="my-far-table">
      <view class="my-center-vertically">
        <text class="my-inline-label" v-if=" !item.labelHidden " />
        <text class="my-inline-label-transparent" v-else-if=" item.prefix ">{{ item.prefix }}</text>
        <text class="my-font my-inline-text" v-if=" !item.labelHidden ">{{ item.label }}：</text>
      </view>
      <view style="color: #7B7B7B; width: 50%;" class="my-far-table" :hidden=" item.editing " :onTap="onEdit" >
        <view v-if=" item.type === 'realTime' " class="my-far-table" style="width: 100%"><text />
          <picker mode="date" :value=" item.value"  :onChange="onEditComplete">
            <text class="my-inline-text my-ellipsis">{{ item.value || '请输入时间' }}</text>
          </picker>
        </view>
        <!-- van组件有点问题，暂时先用原生的 -->
        <picker v-else-if=" item.type === 'realRegion' " mode="region" :value=" currentRegion"  :onChange="onRegionSelection" level="region">
          <text class="my-inline-text my-ellipsis " style="display: flex; flex-direction: row-reverse; text-overflow: unset; width:43vw;">{{ item.value }}</text>
        </picker>
        <view v-else style="width: 100%; display: flex; justify-content: flex-end;"><text />
        <text :style="'text-overflow: unset; margin-left: 0.5rem;' + item.type ? '' : 'color: #181818' " class="my-inline-text my-ellipsis">{{ item.name || item.value || item.placeholder }}</text><text v-if="item.postfix">{{ item.postfix }}</text></view>
        <van-icon v-if=" item.type === 'select' || item.type === 'selectArea'" name="arrow" style="margin-left: 0.3rem;" />
      </view>
      <!-- 支持行内编辑 -->
      <input v-if=" item.editing " :value=" item.value" :onBlur="onEditComplete"  :type=" item.type " :placeholder=" item.placeholder " placeholderClass="my-font" style="width: 45vw;" input-class="my-input" class="my-input-field" clearable :error-message=" item.error " />
    </view>
    <view style="border-bottom: 0.1rem solid #F5F5F5; width:92%; margin-left: 4%" v-if=" index + 1 < _formArr.length && !item.inline " />
  </view>
</template>

<script>
import {
reactive,
watch,
onMounted,
} from "vue";

//父系入参
const props = defineProps({
localObj: Object,
});

onMounted(() => {
console.log("加载组件");
});

/* watch(
  () => props.localObj.msgs,
  (newValue, oldValue) => {
      if (newValue) distribute(newValue)
  },
  { immediate: true },
) //处理来自App.vue的消息分发
*/
</script>

<style scoped>
.my-input {
text-align: center !important; font-size: 1rem; padding: 0 !important;
}
.my-input-field > van-cell > view {
text-align: center !important; font-size: 1rem; padding: 0 !important;
}
.my-form-inline {
display: inline-block;
}
.my-inline-label-transparent {
display:inline-block; background-color: transparent; height: 0.5rem; width: 0.5rem; margin-left: 1.5vw; margin-right: 1.5vw; border-radius: 50%;
}
</style>
