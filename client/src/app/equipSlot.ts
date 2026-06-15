// The single cosmetic equip slot key (per-unit slots later). Lives in a PIXI-free
// module so createAppCore can read SaveData.equipped[…] without importing the
// CollectionScene (which pulls in the render layer). CollectionScene re-exports
// this as COLLECTION_EQUIP_SLOT for backward compatibility.
export const EQUIP_SLOT = 'unit';
