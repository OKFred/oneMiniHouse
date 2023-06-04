<template>
  <!-- 提示消息和对话框 -->
  <!-- <u-toast ref="uToastRef" /> -->
  <u-modal :show="localObj.modal.show" :title="localObj.modal.title" :content='localObj.modal.content' :zoom="true"
    :closeOnClickOverlay="true" @confirm="onModalConfirm" @cancel="onModalCancel" @close="onModalCancel"
    :showConfirmButton="!localObj.modal.hideButtons" :showCancelButton="!localObj.modal.hideButtons" />
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
  ref
} from 'vue'

const props = defineProps({
  globalObj: Object,
});

//  let uToastRef = ref(null)
let localObj = reactive({
  modal: {
    show: false,
    title: '',
    content: '',
    hideButtons: false,
  }
})

/*globalThis.queryResult = function queryResult(status, info) {
  uToastRef.value?.show({
    duration: status ? 2000 : 4000,
    type: status ? 'success' : 'error',
    position: 'top',
    message: info,
  })
} */

globalThis.showModal = function showModal({
  content,
  title = "对话框",
  callback = console.log,
  confirmButtonText = "确定",
  cancelButtonText = "取消",
  hideButtons = false,
}) {
  return Object.assign(localObj.modal, {
    show: true,
    title,
    content,
    callback,
    cancelText: cancelButtonText,
    confirmText: confirmButtonText,
    hideButtons
  });
};

function onModalConfirm() {
  localObj.modal.callback(true);
  cleanUp();
}

function onModalCancel() {
  localObj.modal.callback(false);
  cleanUp();
}

function cleanUp() {
  Object.assign(localObj.modal, {
    show: false,
    title: '',
    content: '',
    hideButtons: false,
    callback: () => { },
  })
}

uni.setNavigationBarTitle({
  title: globalThis.app.globalData?.appPublicName
});

</script>

<style></style>
