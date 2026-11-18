package dev.audismp.basehider.test;

import io.papermc.paper.registry.RegistryAccess;
import io.papermc.paper.registry.RegistryKey;
import io.papermc.paper.registry.tag.Tag;
import io.papermc.paper.registry.tag.TagKey;
import org.bukkit.Keyed;
import org.bukkit.NamespacedKey;
import org.bukkit.Registry;
import org.bukkit.block.BlockType;
import org.bukkit.inventory.ItemType;

import java.lang.reflect.InvocationHandler;
import java.lang.reflect.Method;
import java.lang.reflect.Proxy;
import java.util.Collection;
import java.util.Collections;
import java.util.Iterator;
import java.util.List;
import java.util.stream.Stream;

/**
 * Minimal {@link RegistryAccess} for the pure-unit-test JVM.
 *
 * <p>Paper 1.21.4's {@code Material#isBlock()} resolves {@code Registry.BLOCK}; without a
 * server the API throws "No RegistryAccess implementation found". This provider is
 * registered through {@code META-INF/services} in test resources and returns synthetic
 * BlockType/ItemType keys so Material classification can be tested without a running
 * server. Test infrastructure only - never shipped in the plugin jar.
 */
public final class TestRegistryAccess implements RegistryAccess {

    @Override
    @SuppressWarnings("unchecked")
    public <T extends Keyed> Registry<T> getRegistry(RegistryKey<T> registryKey) {
        if (registryKey == RegistryKey.BLOCK) {
            return (Registry<T>) new TypedRegistry<>(BlockType.class, "block");
        }
        if (registryKey == RegistryKey.ITEM) {
            return (Registry<T>) new TypedRegistry<>(ItemType.class, "item");
        }
        return (Registry<T>) new EmptyRegistry<>();
    }

    @Override
    @SuppressWarnings("unchecked")
    public <T extends Keyed> Registry<T> getRegistry(Class<T> type) {
        if (type == BlockType.class) {
            return (Registry<T>) new TypedRegistry<>(BlockType.class, "block");
        }
        if (type == ItemType.class) {
            return (Registry<T>) new TypedRegistry<>(ItemType.class, "item");
        }
        return (Registry<T>) new EmptyRegistry<>();
    }

    private abstract static class BaseRegistry<T extends Keyed> implements Registry<T> {
        @Override
        public NamespacedKey getKey(T value) {
            return value == null ? null : value.getKey();
        }

        @Override
        public boolean hasTag(TagKey<T> key) {
            return false;
        }

        @Override
        public Tag<T> getTag(TagKey<T> key) {
            return null;
        }

        @Override
        public Collection<Tag<T>> getTags() {
            return Collections.emptyList();
        }

        @Override
        public Stream<T> stream() {
            return Stream.empty();
        }

        @Override
        public Iterator<T> iterator() {
            return Collections.<T>emptyList().iterator();
        }

        @Override
        public int size() {
            return 0;
        }

        @Override
        public T getOrThrow(NamespacedKey key) {
            T value = get(key);
            if (value == null) {
                throw new IllegalArgumentException("No registry value " + key);
            }
            return value;
        }
    }

    private static final class EmptyRegistry<T extends Keyed> extends BaseRegistry<T> {
        @Override
        public T get(NamespacedKey key) {
            return null;
        }
    }

    private static final class TypedRegistry<T extends Keyed> extends BaseRegistry<T> {
        private final Class<?> interfaceType;
        private final String kind;

        TypedRegistry(Class<?> interfaceType, String kind) {
            this.interfaceType = interfaceType;
            this.kind = kind;
        }

        @Override
        @SuppressWarnings("unchecked")
        public T get(NamespacedKey key) {
            if (key == null) {
                return null;
            }
            return (T) Proxy.newProxyInstance(interfaceType.getClassLoader(),
                    new Class<?>[]{interfaceType}, new KeyedHandler(key, kind));
        }
    }

    private record KeyedHandler(NamespacedKey key, String kind) implements InvocationHandler {
        @Override
        public Object invoke(Object proxy, Method method, Object[] args) {
            switch (method.getName()) {
                case "key", "getKey":
                    return key;
                case "translationKey", "getName":
                    return kind + "." + key.getKey();
                case "toString":
                    return "Test" + kind + "[" + key + "]";
                case "hashCode":
                    return key.hashCode();
                case "equals":
                    return args != null && args.length == 1 && proxy == args[0];
                case "isAir":
                    String path = key.getKey();
                    return path.equals("air") || path.equals("cave_air") || path.equals("void_air");
                case "isSolid":
                case "isOccluding":
                    return true;
                default:
                    Class<?> returnType = method.getReturnType();
                    if (returnType == boolean.class) {
                        return false;
                    }
                    if (returnType == int.class) {
                        return 0;
                    }
                    if (returnType == float.class) {
                        return 0.0f;
                    }
                    if (returnType == double.class) {
                        return 0.0d;
                    }
                    if (returnType == long.class) {
                        return 0L;
                    }
                    return null;
            }
        }
    }
}
