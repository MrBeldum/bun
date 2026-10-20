#include "root.h"
#include <JavaScriptCore/JSCInlines.h>
#include <JavaScriptCore/JSPromise.h>
#include <JavaScriptCore/JSPromisePrototype.h>

// The promise or a class of it has a `then`, a function or an accessor, before any `Promise.prototype`.
extern "C" [[ZIG_EXPORT(nothrow)]] bool JSC__JSPromise__hasCustomThen(JSC::JSGlobalObject* globalObject, JSC::JSPromise* promise)
{
    if (promise->structure() == globalObject->promiseStructure()) [[likely]]
        return false;
    auto& vm = JSC::getVM(globalObject);
    auto scope = DECLARE_TOP_EXCEPTION_SCOPE(vm);
    // VMInquiry: the lookup runs no script. A Proxy on the way taints the slot instead.
    JSC::PropertySlot slot(promise, JSC::PropertySlot::InternalMethodType::VMInquiry, &vm);
    bool found = promise->getNonIndexPropertySlot(globalObject, vm.propertyNames->then, slot);
    scope.assertNoExceptionExceptTermination();
    if (slot.isTaintedByOpaqueObject())
        return true;
    if (!found || slot.slotBase()->inherits<JSC::JSPromisePrototype>())
        return false;
    return !slot.isValue() || slot.getPureResult().isCallable();
}
