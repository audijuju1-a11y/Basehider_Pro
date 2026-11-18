import com.github.retrooper.packetevents.protocol.entity.type.EntityTypes;
import com.github.retrooper.packetevents.protocol.player.ClientVersion;
public class PeIds {
  public static void main(String[] args) {
    for (int id : new int[]{1,24,28,30,104,111,5}) {
      try {
        var t = EntityTypes.getById(ClientVersion.V_1_21_4, id);
        System.out.println(id + " -> " + (t == null ? "null" : t.getName()));
      } catch (Throwable e) { System.out.println(id + " -> ERROR " + e); }
    }
  }
}
